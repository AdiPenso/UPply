// UPply — /ai Lambda
// Personal career assistant powered by OpenAI.
//
// Modes (sent in POST body as `mode`):
//   "chat"        — conversational career coach (uses conversation history)
//   "analyze_job" — structured job-fit analysis for a specific posting
//
// Required env vars:
//   OPENAI_API_KEY  — OpenAI secret key (set in Lambda console, never in git)
//   USERS_TABLE     — DynamoDB users table name (default: "Users")
//   ACTIVITY_TABLE  — DynamoDB activity table name (default: "UserActivity")
//
// Models used:
//   Chat:    gpt-4o-mini-search-preview  (built-in web search, no temperature param)
//   Analyze: gpt-4.1-mini               (needs stronger reasoning for structured JSON)
//
// Required env vars (add to Lambda console):
//   DOCUMENTS_TABLE — UserDocuments table name (default: "UserDocuments")

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const OPENAI_CHAT_URL      = "https://api.openai.com/v1/chat/completions";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CHAT_MODEL  = "gpt-4o-mini-search-preview";   // Responses API + built-in web search
const ANLZ_MODEL  = "gpt-4.1-mini";                 // Chat Completions API

const USERS_TABLE      = process.env.USERS_TABLE      || "Users";
const ACTIVITY_TABLE   = process.env.ACTIVITY_TABLE   || "UserActivity";
const DOCUMENTS_TABLE  = process.env.DOCUMENTS_TABLE  || "UserDocuments";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};

const ok  = (b)          => ({ statusCode: 200, headers: CORS, body: JSON.stringify(b) });
const bad = (m, c = 400) => ({ statusCode: c,   headers: CORS, body: JSON.stringify({ error: m }) });

// Structured logger — each line is one JSON object in CloudWatch
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }));

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

async function fetchProfile(userId) {
  try {
    const res = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
    }));
    return res.Item || {};
  } catch (e) {
    console.warn("fetchProfile error:", e.message);
    return {};
  }
}

async function fetchPrimaryCV(userId) {
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: DOCUMENTS_TABLE,
      KeyConditionExpression: "user_id = :u",
      FilterExpression: "is_primary = :t",
      ExpressionAttributeValues: { ":u": userId, ":t": true },
      Limit: 1,
    }));
    const item = res.Items?.[0];
    return item?.cv_text || null;
  } catch (e) {
    console.warn("fetchPrimaryCV error:", e.message);
    return null;
  }
}

async function fetchActivityCounts(userId) {
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: ACTIVITY_TABLE,
      KeyConditionExpression: "user_id = :u",
      ExpressionAttributeValues: { ":u": userId },
      Select: "COUNT",
    }));
    // Rough split: assume half are saves, half are applies (good enough for context)
    return { total: res.Count || 0 };
  } catch {
    return { total: 0 };
  }
}

// ── OpenAI helpers ────────────────────────────────────────────────────────────

// Standard Chat Completions API — used for analyze_job and extract_cv
async function callOpenAI(model, messages, maxTokens, temperature = 0.7) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY environment variable is not set");

  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// Responses API — used for gpt-4o-mini-search-preview (has built-in web search)
// Falls back to gpt-4.1-mini via Chat Completions if the search model fails.
async function callOpenAIWithSearch(messages, maxTokens) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY environment variable is not set");

  // ── Try Responses API with web search first ──────────────────────────────
  try {
    const systemMsg = messages.find(m => m.role === "system");
    const inputMessages = messages.filter(m => m.role !== "system");

    const payload = {
      model: CHAT_MODEL,
      tools: [{ type: "web_search_preview" }],
      max_output_tokens: maxTokens,
      input: inputMessages,
    };
    if (systemMsg) payload.instructions = systemMsg.content;

    const res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text();
      // Log the full error so we can see it in CloudWatch, then fall back
      log("warn", "Search model failed — falling back to gpt-4.1-mini", {
        status: res.status,
        body: txt.slice(0, 500),
      });
      throw new Error(`search_model_unavailable`);
    }

    const data = await res.json();
    const textBlock = data.output
      ?.find(o => o.type === "message")
      ?.content?.find(c => c.type === "output_text");
    const text = textBlock?.text?.trim() || "";
    if (!text) throw new Error("search_model_empty_response");

    log("info", "Chat answered via search model (web search enabled)");
    return text;

  } catch (err) {
    if (err.message !== "search_model_unavailable" && err.message !== "search_model_empty_response") {
      log("warn", "Search model threw unexpectedly — falling back", { error: err.message });
    }
  }

  // ── Fallback: Chat Completions with gpt-4.1-mini ─────────────────────────
  log("info", "Using fallback model gpt-4.1-mini (no web search)");
  return callOpenAI("gpt-4.1-mini", messages, maxTokens, 0.7);
}

// ── Profile → readable context string ────────────────────────────────────────

function profileContext(p, actCounts) {
  const skills  = Array.isArray(p.skills) && p.skills.length ? p.skills.join(", ") : "not listed";
  const salary  = p.desired_salary_min
    ? `${p.desired_salary_min}–${p.desired_salary_max || "?"} USD/yr`
    : "not specified";

  return `
Candidate Profile:
  Name:               ${[p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown"}
  Current title:      ${p.title               || "not specified"}
  Location:           ${p.location            || "not specified"}
  Years experience:   ${p.years_experience    || "not specified"}
  Skills:             ${skills}
  Bio:                ${p.bio                 || "not provided"}
  Desired role:       ${p.desired_role        || "not specified"}
  Work mode pref:     ${p.work_mode           || "any"}
  Salary expectation: ${salary}
  Activity:           ${actCounts.total} saved/applied jobs tracked so far
`.trim();
}

// ── Mode: chat ────────────────────────────────────────────────────────────────

async function handleChat(userId, message, history) {
  log("info", "Chat request", { user_id: userId, history_length: history.length, message_length: message.length });
  const [profile, actCounts, cvText] = await Promise.all([
    fetchProfile(userId),
    fetchActivityCounts(userId),
    fetchPrimaryCV(userId),
  ]);

  const cvSection = cvText
    ? `\nUser's Primary CV (full text):\n---\n${cvText.slice(0, 6000)}\n---`
    : "\n(No CV uploaded yet — advise based on profile fields only.)";

  const systemPrompt = `You are a personal AI career coach for ${profile.first_name || "the user"} on UPply, a job-search platform.
You have access to real-time web search — use it when the user asks about current salary ranges, job market trends, company info, or anything that benefits from up-to-date data.

${profileContext(profile, actCounts)}
${cvSection}

Your role:
- Give honest, specific, actionable career advice.
- Help with resume improvement, interview prep, job strategy, skill gaps.
- When relevant, search the web for current data (salary benchmarks, industry trends, company reviews).
- Keep replies concise (3–5 short paragraphs max). Use bullet points when helpful.
- Be warm, encouraging, and professional.
- If the user asks to search for jobs, tell them to use the search bar at the top and suggest good keywords for their situation.`;

  // Keep last 10 messages as context (5 exchanges) to limit token usage
  const trimmedHistory = history.slice(-10);

  const messages = [
    { role: "system",    content: systemPrompt },
    ...trimmedHistory,
    { role: "user",      content: message },
  ];

  const reply = await callOpenAIWithSearch(messages, 600);
  log("info", "Chat reply generated", { user_id: userId, reply_length: reply.length });
  return { reply };
}

// ── Mode: analyze_job ─────────────────────────────────────────────────────────

async function handleAnalyzeJob(userId, job) {
  log("info", "Job analysis request", { user_id: userId, job_title: job.title, company: job.company });
  const profile = await fetchProfile(userId);

  const systemPrompt = `You are an expert career advisor and recruiter. Analyze job fit objectively.
Return ONLY a valid JSON object — no markdown fences, no text before or after the JSON.`;

  const userPrompt = `${profileContext(profile, { total: 0 })}

Job Posting:
  Title:       ${job.title       || "Unknown"}
  Company:     ${job.company     || "Unknown"}
  Location:    ${job.location    || "Unknown"}
  Description: ${(job.description || "Not provided").slice(0, 2500)}

Return JSON with exactly these keys:
{
  "fit_score": <integer 0–100>,
  "verdict": "<one of: Excellent match | Strong match | Good match | Moderate match | Weak match>",
  "strengths": ["<max 3 specific strengths based on the profile vs job>"],
  "gaps": ["<max 3 specific gaps or missing requirements>"],
  "recommendations": ["<max 3 concrete actions the candidate can take before applying>"],
  "key_requirements": ["<up to 5 important requirements extracted from the job description>"]
}`;

  const raw = await callOpenAI(ANLZ_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt },
  ], 800, 0.2);

  // Strip potential markdown code fences before parsing
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    const result = JSON.parse(cleaned);
    log("info", "Job analysis complete", { fit_score: result.fit_score, verdict: result.verdict });
    return result;
  } catch {
    log("error", "JSON parse failed for job analysis", { raw_snippet: raw.slice(0, 200) });
    throw new Error("AI returned an unexpected format. Please try again.");
  }
}

// ── Mode: extract_cv ──────────────────────────────────────────────────────────

async function handleExtractCV(cvText) {
  log("info", "CV extraction request", { cv_text_length: cvText.length });
  const systemPrompt = `You are a professional CV/resume parser. Extract structured data accurately.
Return ONLY a valid JSON object. No markdown fences, no text outside the JSON.`;

  const userPrompt = `Parse this CV and return a JSON object with exactly these keys
(use empty string "" for missing text fields, null for missing numbers, [] for missing arrays):
{
  "first_name": "",
  "last_name": "",
  "title": "",
  "years_experience": null,
  "skills": [],
  "bio": "",
  "location": "",
  "desired_role": "",
  "desired_salary_min": null,
  "desired_salary_max": null
}

Rules:
- skills: specific technical/professional skills only, max 15 items
- bio: write a concise 2-3 sentence professional summary from the CV content
- years_experience: estimate as a number from work history dates (e.g. 3)
- desired_role: infer the best-fit job title from their experience

CV TEXT:
${cvText.slice(0, 4500)}`;

  const raw = await callOpenAI(ANLZ_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt },
  ], 700, 0.1);

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const result = JSON.parse(cleaned);
    log("info", "CV extraction complete", {
      extracted_name:   [result.first_name, result.last_name].filter(Boolean).join(" ") || "unknown",
      skills_count:     Array.isArray(result.skills) ? result.skills.length : 0,
      years_experience: result.years_experience,
    });
    return result;
  } catch {
    log("error", "JSON parse failed for CV extraction", { raw_snippet: raw.slice(0, 200) });
    throw new Error("Could not parse CV data. Please try again.");
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "POST";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (method !== "POST")   return bad("Method not allowed", 405);

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return bad("Invalid JSON body");
  }

  const { user_id, mode, message, history = [], job } = body || {};

  if (!user_id) return bad("Missing user_id");
  if (!mode)    return bad("Missing mode");

  try {
    if (mode === "chat") {
      if (!message) return bad("Missing message");
      const result = await handleChat(user_id, message, history);
      return ok(result);
    }

    if (mode === "analyze_job") {
      if (!job || !job.title) return bad("Missing job data");
      const result = await handleAnalyzeJob(user_id, job);
      return ok(result);
    }

    if (mode === "extract_cv") {
      const { cv_text } = body;
      if (!cv_text) return bad("Missing cv_text");
      const result = await handleExtractCV(cv_text);
      return ok(result);
    }

    return bad(`Unknown mode: ${mode}`);

  } catch (err) {
    log("error", "AI Lambda unhandled error", { error: err.message, stack: err.stack });
    return bad(err.message || "AI service error", 500);
  }
};
