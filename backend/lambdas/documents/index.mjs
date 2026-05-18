// UPply — /documents Lambda
// Manages the UserDocuments table (one row per uploaded CV per user).
//
// GET  ?action=list&user_id=xxx          → list all CVs (no cv_text — it's large)
// GET  ?action=download_url&user_id=xxx&doc_id=xxx → presigned S3 GET URL
// POST { action:"save",        user_id, doc_id, s3_key, file_name, cv_text, is_primary }
// POST { action:"set_primary", user_id, doc_id }
// POST { action:"delete",      user_id, doc_id }
//
// Required env vars:
//   DOCUMENTS_TABLE — DynamoDB table name (default: "UserDocuments")
//   BUCKET_NAME     — S3 bucket name     (default: "upply-resumes")

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const ddb    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3     = new S3Client({});
const TABLE  = process.env.DOCUMENTS_TABLE || "UserDocuments";
const BUCKET = process.env.BUCKET_NAME     || "upply-resumes";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json",
};

const ok  = (b)          => ({ statusCode: 200, headers: CORS, body: JSON.stringify(b) });
const bad = (m, c = 400) => ({ statusCode: c,   headers: CORS, body: JSON.stringify({ error: m }) });

// Structured logger — every line is one JSON object in CloudWatch
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }));

// ── helpers ───────────────────────────────────────────────────────────────────

async function listDocs(userId) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "user_id = :u",
    ExpressionAttributeValues: { ":u": userId },
  }));
  // Strip cv_text from the list response — it can be huge
  return (res.Items || [])
    .map(({ cv_text, ...rest }) => rest)
    .sort((a, b) => (b.uploaded_at || "").localeCompare(a.uploaded_at || ""));
}

async function getDoc(userId, docId) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "user_id = :u AND doc_id = :d",
    ExpressionAttributeValues: { ":u": userId, ":d": docId },
  }));
  return res.Items?.[0] || null;
}

async function unmarkAllPrimary(userId) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "user_id = :u",
    FilterExpression: "is_primary = :t",
    ExpressionAttributeValues: { ":u": userId, ":t": true },
  }));
  for (const item of (res.Items || [])) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { user_id: userId, doc_id: item.doc_id },
      UpdateExpression: "SET is_primary = :f",
      ExpressionAttributeValues: { ":f": false },
    }));
  }
}

// ── handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  log("info", "Request received", { method });

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (method === "GET") {
      const p       = event.queryStringParameters || {};
      const action  = p.action || "list";
      const user_id = p.user_id;
      if (!user_id) return bad("Missing user_id");

      log("info", "GET action", { action, user_id });

      if (action === "list") {
        const documents = await listDocs(user_id);
        log("info", "Listed documents", { user_id, count: documents.length });
        return ok({ documents });
      }

      if (action === "download_url") {
        const { doc_id } = p;
        if (!doc_id) return bad("Missing doc_id");

        const doc = await getDoc(user_id, doc_id);
        if (!doc) {
          log("warn", "Document not found for download", { user_id, doc_id });
          return bad("Document not found", 404);
        }

        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: doc.s3_key }),
          { expiresIn: 300 }
        );
        log("info", "Download URL generated", { user_id, doc_id, s3_key: doc.s3_key });
        return ok({ download_url: url });
      }

      return bad(`Unknown action: ${action}`);
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (method === "POST") {
      let body;
      try {
        body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      } catch {
        log("warn", "Invalid JSON body");
        return bad("Invalid JSON body");
      }

      const { action, user_id } = body || {};
      if (!user_id) return bad("Missing user_id");
      if (!action)  return bad("Missing action");

      log("info", "POST action", { action, user_id });

      // ── save ──────────────────────────────────────────────────────────────
      if (action === "save") {
        const { doc_id, s3_key, file_name, cv_text, is_primary } = body;
        if (!doc_id || !s3_key || !file_name) return bad("Missing required fields");

        if (is_primary) {
          log("info", "Unmarking all existing primary CVs", { user_id });
          await unmarkAllPrimary(user_id);
        }

        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: {
            user_id,
            doc_id,
            s3_key,
            file_name,
            cv_text:     cv_text     || "",
            is_primary:  is_primary  || false,
            uploaded_at: new Date().toISOString(),
          },
        }));

        log("info", "Document saved", { user_id, doc_id, s3_key, is_primary, file_name });
        return ok({ success: true });
      }

      // ── set_primary ───────────────────────────────────────────────────────
      if (action === "set_primary") {
        const { doc_id } = body;
        if (!doc_id) return bad("Missing doc_id");

        const all = await ddb.send(new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: "user_id = :u",
          ExpressionAttributeValues: { ":u": user_id },
        }));

        for (const item of (all.Items || [])) {
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { user_id, doc_id: item.doc_id },
            UpdateExpression: "SET is_primary = :v",
            ExpressionAttributeValues: { ":v": item.doc_id === doc_id },
          }));
        }

        log("info", "Primary CV updated", { user_id, doc_id });
        return ok({ success: true });
      }

      // ── delete ────────────────────────────────────────────────────────────
      if (action === "delete") {
        const { doc_id } = body;
        if (!doc_id) return bad("Missing doc_id");

        const doc = await getDoc(user_id, doc_id);

        await ddb.send(new DeleteCommand({
          TableName: TABLE,
          Key: { user_id, doc_id },
        }));
        log("info", "Document deleted from DynamoDB", { user_id, doc_id });

        if (doc?.s3_key) {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: doc.s3_key }));
          log("info", "File deleted from S3", { user_id, s3_key: doc.s3_key });
        }

        return ok({ success: true });
      }

      return bad(`Unknown action: ${action}`);
    }

    return bad("Method not allowed", 405);

  } catch (err) {
    log("error", "Unhandled Lambda error", { error: err.message, stack: err.stack });
    return bad(err.message || "Server error", 500);
  }
};
