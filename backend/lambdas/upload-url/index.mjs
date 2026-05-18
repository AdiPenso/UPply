// UPply — /upload-url Lambda
// Generates a presigned S3 PUT URL so the browser can upload a PDF directly
// to S3 without routing the file bytes through Lambda.
//
// POST body: { user_id, file_name }
// Returns:   { upload_url, s3_key }
//
// Required env vars:
//   BUCKET_NAME — S3 bucket name (default: "upply-resumes")

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3     = new S3Client({});
const BUCKET = process.env.BUCKET_NAME || "upply-resumes";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};

const ok  = (b)          => ({ statusCode: 200, headers: CORS, body: JSON.stringify(b) });
const bad = (m, c = 400) => ({ statusCode: c,   headers: CORS, body: JSON.stringify({ error: m }) });

// Structured logger — every line is one JSON object in CloudWatch
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }));

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "POST";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (method !== "POST")   return bad("Method not allowed", 405);

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    log("warn", "Invalid JSON body received");
    return bad("Invalid JSON body");
  }

  const { user_id, file_name } = body || {};
  if (!user_id)   { log("warn", "Missing user_id");   return bad("Missing user_id"); }
  if (!file_name) { log("warn", "Missing file_name"); return bad("Missing file_name"); }

  log("info", "Presign request", { user_id, file_name });

  // Sanitise filename — keep only safe characters
  const safe      = file_name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const timestamp = Date.now();
  const s3_key    = `users/${user_id}/${timestamp}_${safe}`;

  try {
    const command    = new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         s3_key,
      ContentType: "application/pdf",
    });
    const upload_url = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 min

    log("info", "Presigned URL generated", { user_id, s3_key, bucket: BUCKET });
    return ok({ upload_url, s3_key });
  } catch (err) {
    log("error", "Failed to generate presigned URL", { user_id, error: err.message });
    return bad(err.message || "Could not generate upload URL", 500);
  }
};
