// UPply — /profile (GET) Lambda
// Returns the full profile for a given user_id, plus an `exists` flag
// (used by the registration flow to decide whether to send the user to
// the complete-profile page or straight to /home).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.USERS_TABLE || "Users";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Content-Type": "application/json",
};

const ok  = (body)          => ({ statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) });
const bad = (msg, code=400) => ({ statusCode: code, headers: CORS_HEADERS, body: JSON.stringify({ error: msg }) });

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }));

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

  const userId = event.queryStringParameters?.user_id;
  if (!userId) {
    log("warn", "Missing user_id in request");
    return bad("Missing user_id");
  }

  log("info", "Profile GET request", { user_id: userId });

  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { user_id: userId },
    }));

    if (!res.Item) {
      log("info", "Profile not found — new user", { user_id: userId });
      return ok({ exists: false });
    }

    log("info", "Profile found", { user_id: userId, has_skills: Array.isArray(res.Item.skills) });
    return ok({ exists: true, ...res.Item });
  } catch (err) {
    log("error", "profile-get failed", { user_id: userId, error: err.message });
    return bad(err.message || "Get failed", 500);
  }
};
