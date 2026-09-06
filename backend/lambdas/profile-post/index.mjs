// UPply — /profile (POST) Lambda
// Creates a new user profile in DynamoDB during registration.
// Stores all fields the registration form sends, including location.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.USERS_TABLE || "Users";
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

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "POST";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    log("warn", "Invalid JSON body");
    return bad("Invalid JSON body");
  }
  if (!body || typeof body !== "object") return bad("Missing body");

  const { user_id, email, first_name, last_name, phone, location } = body;

  if (!user_id)    { log("warn", "Missing user_id");    return bad("Missing user_id"); }
  if (!email)      { log("warn", "Missing email");      return bad("Missing email"); }
  if (!first_name) { log("warn", "Missing first_name"); return bad("Missing first_name"); }
  if (!last_name)  { log("warn", "Missing last_name");  return bad("Missing last_name"); }

  // Log only the (pseudonymous) user_id — email and name are PII and must not
  // land in CloudWatch. has_* flags keep the log useful without the values.
  log("info", "Creating new profile", { user_id, has_phone: !!phone, has_location: !!location });

  const item = {
    user_id,
    email,
    first_name,
    last_name,
    auth_provider: "cognito",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (phone)    item.phone    = phone;
  if (location) item.location = location;

  try {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    log("info", "Profile created successfully", { user_id });
    return ok({ ok: true, profile: item });
  } catch (err) {
    log("error", "profile-post failed", { user_id, error: err.message });
    return bad(err.message || "Create failed", 500);
  }
};
