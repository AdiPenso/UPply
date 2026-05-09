// UPply — /activity (POST) Lambda
// Tracks user activity in the UserActivity DynamoDB table.
// Schema: PK = user_id (String), SK = activity_id (String)
//   - save:   activity_id = "save#{job_url_b64}"   (deterministic — unsave deletes the same key)
//   - apply:  activity_id = "apply#{timestamp}#{job_url_b64}"  (event log — multiple applies allowed)
// Item shape:
//   { user_id, activity_id, action, job_url, job_title, company, location, timestamp,
//     status (apply only) }

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.ACTIVITY_TABLE || "UserActivity";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};

const ok = (body) => ({
  statusCode: 200,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});
const bad = (msg, code = 400) => ({
  statusCode: code,
  headers: CORS_HEADERS,
  body: JSON.stringify({ error: msg }),
});

// URL-safe base64 (deterministic, short-ish, no "/" or "+" that could collide
// with our "#" separator in the sort key).
const encodeUrl = (url) =>
  Buffer.from(url, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const handler = async (event) => {
  const method =
    event.requestContext?.http?.method || event.httpMethod || "POST";
  if (method === "OPTIONS")
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return bad("Invalid JSON body");
  }
  if (!body) return bad("Missing body");

  const { user_id, action, job } = body;
  if (!user_id) return bad("Missing user_id");
  if (!["save", "unsave", "apply"].includes(action))
    return bad("Invalid action — must be save, unsave, or apply");
  if (!job || !job.job_url) return bad("Missing job.job_url");

  const timestamp = new Date().toISOString();
  const urlKey = encodeUrl(job.job_url);

  try {
    if (action === "save") {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            user_id,
            activity_id: `save#${urlKey}`,
            action: "save",
            job_url: job.job_url,
            job_title: job.title || "",
            company: job.company || "",
            location: job.location || "",
            timestamp,
          },
        })
      );
      return ok({ ok: true, action: "save" });
    }

    if (action === "unsave") {
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { user_id, activity_id: `save#${urlKey}` },
        })
      );
      return ok({ ok: true, action: "unsave" });
    }

    // apply — event log; multiple applies create multiple rows
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          user_id,
          activity_id: `apply#${timestamp}#${urlKey}`,
          action: "apply",
          job_url: job.job_url,
          job_title: job.title || "",
          company: job.company || "",
          location: job.location || "",
          timestamp,
          status: "applied",
        },
      })
    );
    return ok({ ok: true, action: "apply" });
  } catch (err) {
    console.error("activity-track error:", err);
    return bad(err.message || "Write failed", 500);
  }
};
