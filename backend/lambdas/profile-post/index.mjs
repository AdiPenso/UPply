// UPply — /profile (POST) Lambda
// Creates a new user profile in DynamoDB during registration.
// Stores all fields the registration form sends, including location.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.USERS_TABLE || "Users";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};

function ok(body) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}
function bad(msg, code = 400) {
  return {
    statusCode: code,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: msg }),
  };
}

export const handler = async (event) => {
  const method =
    event.requestContext?.http?.method || event.httpMethod || "POST";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return bad("Invalid JSON body");
  }
  if (!body || typeof body !== "object") return bad("Missing body");

  const { user_id, email, first_name, last_name, phone, location } = body;

  if (!user_id) return bad("Missing user_id");
  if (!email) return bad("Missing email");
  if (!first_name) return bad("Missing first_name");
  if (!last_name) return bad("Missing last_name");

  const item = {
    user_id,
    email,
    first_name,
    last_name,
    auth_provider: "cognito",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Optional fields — only write if provided (DynamoDB is happy with missing attrs)
  if (phone) item.phone = phone;
  if (location) item.location = location;

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );
    return ok({ ok: true, profile: item });
  } catch (err) {
    console.error("profile-post error:", err);
    return bad(err.message || "Create failed", 500);
  }
};
