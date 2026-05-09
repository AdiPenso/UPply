// UPply — /activity (GET) Lambda
// Reads all UserActivity rows for a user and splits them into saved + applied.
// Query: GET /activity?user_id=xxx
// Returns: { saved: [...], applied: [...], saved_count, applied_count }

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.ACTIVITY_TABLE || "UserActivity";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
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

export const handler = async (event) => {
  const method =
    event.requestContext?.http?.method || event.httpMethod || "GET";
  if (method === "OPTIONS")
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };

  const user_id =
    event.queryStringParameters?.user_id ||
    event.queryStringParameters?.userId;
  if (!user_id) return bad("Missing user_id");

  try {
    // Query all rows for this user (paginate in case the user has many).
    let items = [];
    let ExclusiveStartKey;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "user_id = :u",
          ExpressionAttributeValues: { ":u": user_id },
          ExclusiveStartKey,
        })
      );
      items = items.concat(res.Items || []);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    const toJob = (it) => ({
      activity_id: it.activity_id,   // needed by the frontend for update/delete
      job_url: it.job_url,
      title: it.job_title || "",
      company: it.company || "",
      location: it.location || "",
      timestamp: it.timestamp || "",
      status: it.status || (it.action === "apply" ? "applied" : undefined),
    });

    // Newest first
    const byTimeDesc = (a, b) =>
      (b.timestamp || "").localeCompare(a.timestamp || "");

    const saved = items
      .filter((it) => it.action === "save")
      .map(toJob)
      .sort(byTimeDesc);
    const applied = items
      .filter((it) => it.action === "apply")
      .map(toJob)
      .sort(byTimeDesc);

    return ok({
      saved,
      applied,
      saved_count: saved.length,
      applied_count: applied.length,
    });
  } catch (err) {
    console.error("activity-get error:", err);
    return bad(err.message || "Read failed", 500);
  }
};
