// UPply — /profile (PUT) Lambda
// Updates any subset of profile fields in DynamoDB for the given user_id.
// Only fields present in the request body are updated.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.USERS_TABLE || "Users";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "PUT,OPTIONS",
  "Content-Type": "application/json",
};

// Whitelist of fields the client is allowed to update.
const ALLOWED_FIELDS = [
  "first_name",
  "last_name",
  "phone",
  "location",
  "title",
  "years_experience",
  "desired_role",
  "desired_salary_min",
  "desired_salary_max",
  "work_mode",
  "bio",
  "skills",
];

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

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }));

export const handler = async (event) => {
  const method =
    event.requestContext?.http?.method || event.httpMethod || "PUT";

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

  const userId = body.user_id;
  if (!userId) return bad("Missing user_id");

  log("info", "Profile update request", { user_id: userId, fields: Object.keys(body).filter(k => k !== "user_id") });

  // Build dynamic UpdateExpression from whitelisted fields that are present.
  const sets = [];
  const names = {};
  const values = {};
  let idx = 0;

  for (const field of ALLOWED_FIELDS) {
    if (!(field in body)) continue;
    let val = body[field];

    // Normalize empty strings → remove the field instead of setting to ""
    // (so DynamoDB doesn't store noise). We treat "" as "clear this field".
    if (val === "") val = null;

    const nameKey = `#f${idx}`;
    const valueKey = `:v${idx}`;
    names[nameKey] = field;

    if (val === null) {
      sets.push(`${nameKey} = :null`);
    } else {
      sets.push(`${nameKey} = ${valueKey}`);
      values[valueKey] = val;
    }
    idx++;
  }

  if (idx === 0) return bad("No updatable fields provided");

  // Always bump updated_at
  names["#updated_at"] = "updated_at";
  values[":updated_at"] = new Date().toISOString();
  sets.push("#updated_at = :updated_at");

  // Add the :null placeholder only if at least one field is being cleared.
  const usesNull = sets.some((s) => s.includes(":null"));
  if (usesNull) values[":null"] = null;

  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { user_id: userId },
        UpdateExpression: "SET " + sets.join(", "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
    log("info", "Profile updated successfully", { user_id: userId, updated_fields: idx });
    return ok({ profile: res.Attributes });
  } catch (err) {
    log("error", "profile-update failed", { user_id: userId, error: err.message });
    return bad(err.message || "Update failed", 500);
  }
};
