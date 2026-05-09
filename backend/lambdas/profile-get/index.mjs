// UPply — /profile (GET) Lambda
// Returns the full profile for a given user_id, plus an `exists` flag
// (used by the registration flow to decide whether to send the user to
// the complete-profile page or straight to /home).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.USERS_TABLE || "Users";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Content-Type": "application/json",
};

export const handler = async (event) => {
  const method =
    event.requestContext?.http?.method || event.httpMethod || "GET";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const userId = event.queryStringParameters?.user_id;
  if (!userId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Missing user_id" }),
    };
  }

  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { user_id: userId },
      })
    );

    if (!res.Item) {
      // Profile doesn't exist yet — registration flow uses this.
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ exists: false }),
      };
    }

    // Return the full profile flat, plus exists:true for the register flow.
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ exists: true, ...res.Item }),
    };
  } catch (err) {
    console.error("profile-get error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message || "Get failed" }),
    };
  }
};
