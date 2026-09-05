// UPply — /activity (POST) Lambda
// Tracks user activity in the UserActivity DynamoDB table.
// Schema: PK = user_id (String), SK = activity_id (String)
//   - save:   activity_id = "save#{job_url_b64}"   (deterministic — unsave deletes the same key)
//   - apply:  activity_id = "apply#{timestamp}#{job_url_b64}"  (event log — multiple applies allowed)
// Supported actions: save | unsave | apply | update_status | delete

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.ACTIVITY_TABLE || "UserActivity";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};

const ok  = (body)          => ({ statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) });
const bad = (msg, code=400) => ({ statusCode: code, headers: CORS_HEADERS, body: JSON.stringify({ error: msg }) });

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }));

// URL-safe base64 (deterministic, short-ish, no "/" or "+" that could collide
// with our "#" separator in the sort key).
const encodeUrl = (url) =>
  Buffer.from(url, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const VALID_STATUSES = ["applied", "interview", "offer", "accepted", "rejected"];

// A job's stable identity. CareerJet ("jobviewtrack.com") returns a fresh
// tracking URL for the same posting on every search, so the URL alone can't be
// the dedup key — key on title|company when we have a title.
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const identityOf = (title, company) => `${norm(title)}|${norm(company)}`;

async function listSavedRows(user_id) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "user_id = :u AND begins_with(activity_id, :p)",
    ExpressionAttributeValues: { ":u": user_id, ":p": "save#" },
  }));
  return res.Items || [];
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "POST";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return bad("Invalid JSON body");
  }
  if (!body) return bad("Missing body");

  const { user_id, action, job, activity_id, status } = body;
  if (!user_id) return bad("Missing user_id");

  log("info", "Activity track request", { user_id, action, job_title: job?.title, activity_id, status });

  const VALID_ACTIONS = ["save", "unsave", "apply", "update_status", "delete"];
  if (!VALID_ACTIONS.includes(action)) return bad("Invalid action");

  // save / unsave / apply require job.job_url
  if (["save", "unsave", "apply"].includes(action) && (!job || !job.job_url))
    return bad("Missing job.job_url");

  // update_status / delete require activity_id
  if (["update_status", "delete"].includes(action) && !activity_id)
    return bad("Missing activity_id");

  const timestamp = new Date().toISOString();

  try {
    // ── save ─────────────────────────────────────────────────────────────────
    if (action === "save") {
      const identity = job.title ? identityOf(job.title, job.company) : null;
      const existing = await listSavedRows(user_id);

      // Same posting already saved? (same URL, or same title|company). Re-use its
      // row so a re-search / re-save never creates a duplicate.
      const match = existing.find((r) =>
        r.job_url === job.job_url ||
        (identity && identityOf(r.job_title, r.company) === identity)
      );

      const activity_id = match?.activity_id
        || `save#${encodeUrl(identity || job.job_url)}`;

      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          user_id,
          activity_id,
          action: "save",
          job_url:   job.job_url,
          job_title: job.title    || match?.job_title || "",
          company:   job.company  || match?.company   || "",
          location:  job.location || match?.location  || "",
          timestamp: match?.timestamp || timestamp,   // keep the original save time
        },
      }));
      log("info", "Job saved", { user_id, job_title: job.title, company: job.company, deduped: !!match });
      return ok({ ok: true, action: "save", deduped: !!match });
    }

    // ── unsave ────────────────────────────────────────────────────────────────
    if (action === "unsave") {
      const identity = job.title ? identityOf(job.title, job.company) : null;
      const legacyKey = `save#${encodeUrl(job.job_url)}`;
      const existing = await listSavedRows(user_id);

      // Remove every row for this posting — matched by URL, by title|company, or
      // by the legacy URL-only key. Clears older duplicates too.
      const targets = existing.filter((r) =>
        r.job_url === job.job_url ||
        r.activity_id === legacyKey ||
        (identity && identityOf(r.job_title, r.company) === identity)
      );

      await Promise.all(targets.map((r) => ddb.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { user_id, activity_id: r.activity_id },
      }))));
      log("info", "Job unsaved", { user_id, job_title: job.title, removed: targets.length });
      return ok({ ok: true, action: "unsave", removed: targets.length });
    }

    // ── apply ─────────────────────────────────────────────────────────────────
    if (action === "apply") {
      const urlKey = encodeUrl(job.job_url);
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          user_id,
          activity_id: `apply#${timestamp}#${urlKey}`,
          action: "apply",
          job_url:   job.job_url,
          job_title: job.title    || "",
          company:   job.company  || "",
          location:  job.location || "",
          timestamp,
          status: "applied",
        },
      }));
      log("info", "Job application tracked", { user_id, job_title: job.title, company: job.company });
      return ok({ ok: true, action: "apply" });
    }

    // ── update_status ─────────────────────────────────────────────────────────
    if (action === "update_status") {
      if (!VALID_STATUSES.includes(status))
        return bad(`Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`);

      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { user_id, activity_id },
        UpdateExpression: "SET #st = :s",
        ExpressionAttributeNames:  { "#st": "status" },
        ExpressionAttributeValues: { ":s": status },
      }));
      log("info", "Application status updated", { user_id, activity_id, status });
      return ok({ ok: true, action: "update_status", status });
    }

    // ── delete ────────────────────────────────────────────────────────────────
    if (action === "delete") {
      await ddb.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { user_id, activity_id },
      }));
      log("info", "Activity deleted", { user_id, activity_id });
      return ok({ ok: true, action: "delete" });
    }

  } catch (err) {
    log("error", "activity-track failed", { user_id, action, error: err.message });
    return bad(err.message || "Write failed", 500);
  }
};
