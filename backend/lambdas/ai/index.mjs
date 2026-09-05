// UPply — /ai Lambda
// Personal career assistant powered by OpenAI.
//
// Modes (sent in POST body as `mode`):
//   "chat"        — agentic career coach. The model has tools that invoke the
//                   other UPply Lambdas, so it can search jobs, read/update the
//                   profile, save/apply to jobs and analyse fit on its own.
//   "analyze_job" — structured job-fit analysis for a specific posting
//   "cover_letter" — tailored cover letter for a specific posting
//   "tailor_resume" — rewrite the primary CV to fit a specific posting
//   "interview"    — one stateless turn of a 5-question practice interview
//                    (English or Hebrew via `language`)
//   "tts"          — text → speech (OpenAI), returns base64 mp3
//   "extract_cv"  — parse a CV into structured profile fields
//
// Required env vars:
//   OPENAI_API_KEY  — OpenAI secret key (set in Lambda console, never in git)
//   USERS_TABLE     — DynamoDB users table name (default: "Users")
//   ACTIVITY_TABLE  — DynamoDB activity table name (default: "UserActivity")
//
// Optional env vars:
//   DOCUMENTS_TABLE — UserDocuments table name (default: "UserDocuments")
//   MAX_TOOL_ROUNDS — max agent tool-call rounds per message (default: 6)
//   FN_JOBS, FN_ACTIVITY_GET, FN_ACTIVITY_TRACK, FN_PROFILE_GET,
//   FN_PROFILE_UPDATE, FN_DOCUMENTS — deployed names of the sibling Lambdas
//   the agent is allowed to invoke (defaults below).
//
// IAM: this function's execution role needs `lambda:InvokeFunction` on the six
// sibling functions listed above.
//
// Models (all text-only — this project's key has no audio/embedding access):
//   AI_CHAT_MODEL  — chat agent, cover letter, interview   (default gpt-4.1-mini)
//   AI_JSON_MODEL  — analyze_job, extract_cv               (default gpt-4.1-mini)
//   The prompts are tuned for gpt-4.1-mini. The env vars allow trying a cheaper
//   model (e.g. gpt-5-nano) without a redeploy — callOpenAIRaw handles the
//   GPT-5 / o-series parameter differences automatically.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const CHAT_MODEL  = process.env.AI_CHAT_MODEL || "gpt-4.1-mini";   // chat / cover letter / interview
const ANLZ_MODEL  = process.env.AI_JSON_MODEL || "gpt-4.1-mini";   // structured JSON tasks

// GPT-5 / o-series are reasoning models: they reject `temperature`, need
// `max_completion_tokens`, and burn part of that budget on hidden reasoning.
// (Only relevant if AI_*_MODEL is pointed at one of them.)
const isReasoningModel = (m) => /^(gpt-5|o[0-9])/i.test(m || "");
// "minimal" | "low" | "medium" | "high" | "none" (none = omit the param)
const REASONING_EFFORT = process.env.AI_REASONING_EFFORT || "minimal";

const USERS_TABLE      = process.env.USERS_TABLE      || "Users";
const ACTIVITY_TABLE   = process.env.ACTIVITY_TABLE   || "UserActivity";
const DOCUMENTS_TABLE  = process.env.DOCUMENTS_TABLE  || "UserDocuments";

const MAX_TOOL_ROUNDS  = Number(process.env.MAX_TOOL_ROUNDS) || 6;

// Deployed names of the sibling Lambdas the agent may invoke. Defaults match the
// current us-east-1 deployment; override with env vars if the names change.
const FN = {
  jobs:          process.env.FN_JOBS           || "jobs-multi-source-search",
  activityGet:   process.env.FN_ACTIVITY_GET   || "user-activity-get",
  activityTrack: process.env.FN_ACTIVITY_TRACK || "user-activity-track",
  profileGet:    process.env.FN_PROFILE_GET    || "getUserProfile",
  profileUpdate: process.env.FN_PROFILE_UPDATE || "profile-update",
  documents:     process.env.FN_DOCUMENTS      || "upply-documents",
};

const ddb    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

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

// Profile fields the agent is allowed to write (mirrors profile-update's whitelist).
const ALLOWED_PROFILE_FIELDS = [
  "first_name", "last_name", "phone", "location", "title", "years_experience",
  "desired_role", "desired_salary_min", "desired_salary_max", "work_mode", "bio", "skills",
];
const VALID_STATUSES = ["applied", "interview", "offer", "accepted", "rejected"];

// ── DynamoDB helpers (fast path for building chat context) ────────────────────

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
    // Query all of the user's docs (a filtered Limit:1 can skip the primary one),
    // then prefer the primary, falling back to the most recently uploaded.
    const res = await ddb.send(new QueryCommand({
      TableName: DOCUMENTS_TABLE,
      KeyConditionExpression: "user_id = :u",
      ExpressionAttributeValues: { ":u": userId },
    }));
    const items = res.Items || [];
    if (!items.length) return null;
    const primary = items.find((d) => d.is_primary);
    const chosen = primary
      || [...items].sort((a, b) => (b.uploaded_at || "").localeCompare(a.uploaded_at || ""))[0];
    return chosen?.cv_text || null;
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
    // Total saved + applied rows — used only as a rough engagement signal in the prompt.
    return { total: res.Count || 0 };
  } catch {
    return { total: 0 };
  }
}

// ── OpenAI helpers ────────────────────────────────────────────────────────────

// Chat Completions call that returns the full assistant message object
// (so callers can read `tool_calls`). Used by the agent loop.
async function callOpenAIRaw(model, messages, { tools, toolChoice, maxTokens = 600, temperature = 0.7 } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY environment variable is not set");

  const payload = { model, messages };

  if (isReasoningModel(model)) {
    // Reasoning tokens draw from the same budget as the visible answer, so give
    // generous headroom or the model can return empty content. No `temperature`.
    payload.max_completion_tokens = Math.max(maxTokens * 4, 2000);
    if (REASONING_EFFORT !== "none") payload.reasoning_effort = REASONING_EFFORT;
  } else {
    payload.max_tokens = maxTokens;
    payload.temperature = temperature;
  }

  if (tools) {
    payload.tools = tools;
    payload.tool_choice = toolChoice || "auto";
  }

  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message || { role: "assistant", content: "" };
}

// Simple text-only helper — used by analyze_job and extract_cv.
async function callOpenAI(model, messages, maxTokens, temperature = 0.7) {
  const msg = await callOpenAIRaw(model, messages, { maxTokens, temperature });
  return (msg.content || "").trim();
}

// ── Sibling-Lambda invocation ────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True for the errors a retry can actually fix — Lambda / account concurrency
// throttling (common on the AWS Academy lab, whose limit is small) and transient
// 5xx. The AWS Academy budget is tight, so a burst of parallel invokes (e.g. the
// agent saving 3 jobs at once) can throttle some of them.
const isRetryable = (e) => {
  const s = `${e?.name || ""} ${e?.message || ""}`;
  return /Throttl|TooManyRequests|Rate ?Exceeded|ServiceException|429|50[234]/i.test(s);
};

// Invoke a sibling Lambda with a synthetic API-Gateway proxy event and unwrap
// its { statusCode, body } response into a plain object. Retries throttling /
// transient 5xx a few times with backoff.
async function invokeLambda(fnName, opts = {}) {
  const { method = "GET", query = null, body = null } = opts;
  const proxyEvent = {
    requestContext: { http: { method } },
    httpMethod: method,
    queryStringParameters: query,
    body: body ? JSON.stringify(body) : null,
    headers: {},
  };
  const payload = Buffer.from(JSON.stringify(proxyEvent));

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(250 * 2 ** (attempt - 1) + Math.random() * 200);
    try {
      return await invokeLambdaOnce(fnName, payload);
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === 3) throw e;
      console.warn(`invokeLambda ${fnName} retry ${attempt + 1}: ${e.message}`);
    }
  }
  throw lastErr;
}

async function invokeLambdaOnce(fnName, payload) {
  const res = await lambda.send(new InvokeCommand({
    FunctionName: fnName,
    InvocationType: "RequestResponse",
    Payload: payload,
  }));

  const raw = Buffer.from(res.Payload || []).toString("utf8");

  if (res.FunctionError) {
    throw new Error(`${fnName} failed: ${raw.slice(0, 200)}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`${fnName} returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const statusCode = envelope.statusCode || 200;
  let data = envelope.body;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* leave as string */ }
  }

  if (statusCode >= 400) {
    throw new Error((data && data.error) || `${fnName} HTTP ${statusCode}`);
  }
  return data;
}

// ── Agent tools ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_jobs",
      description:
        "Search live job postings. Routes to CareerJet for Israel and JSearch elsewhere. Returns up to 10 results per page.",
      parameters: {
        type: "object",
        properties: {
          keywords: { type: "string", description: "Job title, skills or keywords, e.g. 'react developer'." },
          location: { type: "string", description: "City and/or country, e.g. 'Tel Aviv, Israel' or 'Berlin'. Optional." },
          page:     { type: "integer", description: "1-based page number. Default 1." },
        },
        required: ["keywords"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_matching_jobs",
      description:
        "Find jobs that fit the user overall. YOU infer 3–6 related job-title " +
        "variations from their profile, CV, skills and career goals, then this " +
        "runs a separate search for each and merges + de-duplicates the results " +
        "into one list. Example: for a software-development internship — " +
        "'software engineer intern', 'student software developer', 'junior " +
        "developer', 'backend intern', 'full stack intern'. Use this whenever " +
        "the user asks you to find jobs that suit THEM, rather than searching " +
        "one exact title with search_jobs.",
      parameters: {
        type: "object",
        properties: {
          titles: {
            type: "array",
            items: { type: "string" },
            description:
              "3–6 short job-title variations, one role each (no skill lists, no " +
              "multiple seniority words in one string). Vary the seniority and " +
              "the sub-role. Each string is run as its own keyword search.",
          },
          location: {
            type: "string",
            description: "City and/or country, e.g. 'Tel Aviv, Israel'. Optional.",
          },
        },
        required: ["titles"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_profile",
      description: "Get the user's current saved profile (name, title, skills, location, salary expectations, bio, etc.).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_my_profile",
      description:
        "Update one or more of the user's profile fields. Only include fields that should change. Pass an empty string to clear a text field.",
      parameters: {
        type: "object",
        properties: {
          first_name:         { type: "string" },
          last_name:          { type: "string" },
          phone:              { type: "string" },
          location:           { type: "string" },
          title:              { type: "string", description: "Current job title." },
          years_experience:   { type: "number" },
          desired_role:       { type: "string" },
          desired_salary_min: { type: "number", description: "USD per year." },
          desired_salary_max: { type: "number", description: "USD per year." },
          work_mode:          { type: "string", enum: ["remote", "hybrid", "onsite", "any"] },
          bio:                { type: "string" },
          skills:             { type: "array", items: { type: "string" }, description: "Full replacement list of skills." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_activity",
      description: "List the jobs the user has saved and the applications they are tracking, with their statuses.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "save_job",
      description: "Add a job to the user's saved list. Use a job_url from search_jobs results.",
      parameters: {
        type: "object",
        properties: {
          job_url:  { type: "string" },
          title:    { type: "string" },
          company:  { type: "string" },
          location: { type: "string" },
        },
        required: ["job_url", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unsave_job",
      description: "Remove a job from the user's saved list, identified by its job_url.",
      parameters: {
        type: "object",
        properties: { job_url: { type: "string" } },
        required: ["job_url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "track_application",
      description:
        "Record that the user has applied to a job. Creates an application row with status 'applied'. Only call this once the user confirms they actually submitted an application.",
      parameters: {
        type: "object",
        properties: {
          job_url:  { type: "string" },
          title:    { type: "string" },
          company:  { type: "string" },
          location: { type: "string" },
        },
        required: ["job_url", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_application_status",
      description: "Change the status of an application the user is tracking. Get the activity_id from get_my_activity.",
      parameters: {
        type: "object",
        properties: {
          activity_id: { type: "string", description: "The activity_id from get_my_activity (starts with 'apply#')." },
          status:      { type: "string", enum: VALID_STATUSES },
        },
        required: ["activity_id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_job_fit",
      description:
        "Score how well the user's profile fits a specific job posting. Returns fit_score, verdict, strengths, gaps and recommendations.",
      parameters: {
        type: "object",
        properties: {
          title:       { type: "string" },
          company:     { type: "string" },
          location:    { type: "string" },
          description: { type: "string", description: "The full job description text." },
        },
        required: ["title", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_cover_letter",
      description:
        "Write a tailored cover letter for the user applying to a specific job, using their profile and CV. Returns the letter text.",
      parameters: {
        type: "object",
        properties: {
          title:       { type: "string" },
          company:     { type: "string" },
          description: { type: "string", description: "The job description text." },
          emphasis:    { type: "string", description: "Optional: something the user wants highlighted." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_cvs",
      description: "List the CV files the user has uploaded, including which one is currently primary.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_primary_cv",
      description: "Mark one uploaded CV as the primary one (the CV the assistant reads). Get doc_id from list_my_cvs.",
      parameters: {
        type: "object",
        properties: { doc_id: { type: "string" } },
        required: ["doc_id"],
      },
    },
  },
];

// Tools that change stored data — surfaced to the client so it can refresh.
const MUTATING_TOOLS = new Set([
  "update_my_profile", "save_job", "unsave_job",
  "track_application", "update_application_status", "set_primary_cv",
]);

// Short human-readable label for the chat's action trace.
const TOOL_LABELS = {
  search_jobs:               (a) => `Searched jobs: “${a.keywords || ""}”${a.location ? ` in ${a.location}` : ""}`,
  find_matching_jobs:        (a) => {
    const t = Array.isArray(a.titles) ? a.titles : [];
    return `Searched ${t.length} related role${t.length === 1 ? "" : "s"}: ${t.slice(0, 4).join(", ")}${t.length > 4 ? "…" : ""}${a.location ? ` — ${a.location}` : ""}`;
  },
  get_my_profile:            () => "Read your profile",
  update_my_profile:         (a) => `Updated your profile (${Object.keys(a).join(", ")})`,
  get_my_activity:           () => "Checked your saved & applied jobs",
  save_job:                  (a) => `Saved “${a.title || a.job_url}”`,
  unsave_job:                () => "Removed a saved job",
  track_application:         (a) => `Tracked an application to “${a.title || a.job_url}”`,
  update_application_status: (a) => `Set an application status to “${a.status}”`,
  analyze_job_fit:           (a) => `Analysed your fit for “${a.title || "a job"}”`,
  draft_cover_letter:        (a) => `Drafted a cover letter for “${a.title || "a job"}”`,
  list_my_cvs:               () => "Listed your CVs",
  set_primary_cv:            () => "Changed your primary CV",
};

const compactActivity = (it) => ({
  activity_id: it.activity_id,
  title: it.title, company: it.company, location: it.location,
  status: it.status, job_url: it.job_url,
});

// Execute one tool call. `userId` is always injected server-side — never taken
// from the model — so the agent can only ever act on the caller's own data.
async function executeTool(userId, name, args) {
  switch (name) {
    case "search_jobs": {
      const data = await invokeLambda(FN.jobs, {
        method: "GET",
        query: {
          keywords: args.keywords || "",
          location: args.location || "",
          page: String(args.page || 1),
        },
      });
      // Keep the payload small — this goes back into the model's context for the
      // next round, so trim hard: fewer jobs, shorter snippets.
      const jobs = (data.jobs || []).slice(0, 8).map((j) => ({
        title: j.title, company: j.company, location: j.location,
        salary: j.salary || null, isRemote: !!j.isRemote, url: j.url,
        description: (j.description || "").slice(0, 200),
      }));
      return { count: jobs.length, has_more: !!data.has_more, jobs };
    }

    case "find_matching_jobs": {
      const titles = [...new Set(
        (Array.isArray(args.titles) ? args.titles : [])
          .map((t) => String(t || "").trim().toLowerCase())
          .filter(Boolean)
      )].slice(0, 6);
      if (!titles.length) return { error: "Provide 3–6 job titles to search for." };
      const location = args.location || "";

      const searchOne = (kw) => invokeLambda(FN.jobs, {
        method: "GET",
        query: { keywords: kw, location, page: "1" },
      }).then(
        (d) => ({ kw, jobs: d.jobs || [] }),
        (e) => { console.warn("find_matching_jobs sub-search failed:", kw, e.message); return { kw, jobs: [] }; }
      );

      // Limited concurrency (3) so several parallel title searches don't stampede
      // the jobs Lambda and trip its concurrency limit.
      const queue = [...titles];
      const collected = [];
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (queue.length) collected.push(await searchOne(queue.shift()));
        })
      );

      // Round-robin merge across the per-title result sets (so the combined list
      // isn't dominated by the first title), de-duping by url / title+company.
      const lists = collected.map((r) => r.jobs.slice());
      const seen = new Set();
      const merged = [];
      let progressed = true;
      while (progressed && merged.length < 24) {
        progressed = false;
        for (const list of lists) {
          const j = list.shift();
          if (!j) continue;
          progressed = true;
          const key = (j.url || `${j.title}|${j.company}|${j.location}`).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push({
            title: j.title, company: j.company, location: j.location,
            salary: j.salary || null, isRemote: !!j.isRemote, url: j.url,
            description: (j.description || "").slice(0, 200),
          });
        }
      }

      return { queries_run: titles, count: merged.length, jobs: merged.slice(0, 15) };
    }

    case "get_my_profile": {
      const p = await invokeLambda(FN.profileGet, { method: "GET", query: { user_id: userId } });
      // Drop internal bookkeeping fields.
      const { auth_provider, created_at, updated_at, ...rest } = p || {};
      return rest;
    }

    case "update_my_profile": {
      const fields = {};
      for (const f of ALLOWED_PROFILE_FIELDS) {
        if (f in args && args[f] !== undefined) fields[f] = args[f];
      }
      if (!Object.keys(fields).length) return { error: "No updatable fields were provided." };
      const r = await invokeLambda(FN.profileUpdate, {
        method: "PUT",
        body: { user_id: userId, ...fields },
      });
      return { updated_fields: Object.keys(fields), profile: r.profile };
    }

    case "get_my_activity": {
      const a = await invokeLambda(FN.activityGet, { method: "GET", query: { user_id: userId } });
      return {
        saved:        (a.saved   || []).map(compactActivity),
        applied:      (a.applied || []).map(compactActivity),
        saved_count:   a.saved_count   ?? (a.saved   || []).length,
        applied_count: a.applied_count ?? (a.applied || []).length,
      };
    }

    case "save_job":
      return invokeLambda(FN.activityTrack, {
        method: "POST",
        body: {
          user_id: userId, action: "save",
          job: { job_url: args.job_url, title: args.title, company: args.company, location: args.location },
        },
      });

    case "unsave_job":
      return invokeLambda(FN.activityTrack, {
        method: "POST",
        body: { user_id: userId, action: "unsave", job: { job_url: args.job_url } },
      });

    case "track_application":
      return invokeLambda(FN.activityTrack, {
        method: "POST",
        body: {
          user_id: userId, action: "apply",
          job: { job_url: args.job_url, title: args.title, company: args.company, location: args.location },
        },
      });

    case "update_application_status": {
      if (!VALID_STATUSES.includes(args.status)) {
        return { error: `status must be one of: ${VALID_STATUSES.join(", ")}` };
      }
      return invokeLambda(FN.activityTrack, {
        method: "POST",
        body: { user_id: userId, action: "update_status", activity_id: args.activity_id, status: args.status },
      });
    }

    case "analyze_job_fit":
      return handleAnalyzeJob(userId, {
        title: args.title, company: args.company,
        location: args.location, description: args.description,
      });

    case "draft_cover_letter":
      return handleCoverLetter(userId, {
        title: args.title, company: args.company, description: args.description,
      }, { emphasis: args.emphasis });

    case "list_my_cvs": {
      const d = await invokeLambda(FN.documents, {
        method: "GET",
        query: { action: "list", user_id: userId },
      });
      return {
        documents: (d.documents || []).map(({ user_id: _u, s3_key: _s, ...rest }) => rest),
      };
    }

    case "set_primary_cv":
      return invokeLambda(FN.documents, {
        method: "POST",
        body: { user_id: userId, action: "set_primary", doc_id: args.doc_id },
      });

    default:
      return { error: `Unknown tool: ${name}` };
  }
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

// ── Mode: chat (agentic) ─────────────────────────────────────────────────────

async function handleChat(userId, message, history) {
  log("info", "Chat request", { user_id: userId, history_length: history.length, message_length: message.length });

  const [profile, actCounts, cvText] = await Promise.all([
    fetchProfile(userId),
    fetchActivityCounts(userId),
    fetchPrimaryCV(userId),
  ]);

  const cvSection = cvText
    ? `\nUser's Primary CV:\n---\n${cvText.slice(0, 4000)}\n---`
    : "\n(No CV uploaded yet — advise based on profile fields only.)";

  const systemPrompt = `You are a personal AI career agent for ${profile.first_name || "the user"} on UPply, a job-search platform.

${profileContext(profile, actCounts)}
${cvSection}

You can take actions on the user's behalf through tools:
- find_matching_jobs — search several related job titles at once and get one merged list (use for "find jobs that fit me").
- search_jobs — find live job postings for one specific title/keyword.
- get_my_profile / update_my_profile — read and edit the user's profile.
- get_my_activity — see saved jobs and tracked applications (with their activity_id and status).
- save_job / unsave_job — manage the saved list.
- track_application / update_application_status — manage the application pipeline.
- analyze_job_fit — score the user's fit for a specific posting.
- draft_cover_letter — write a tailored cover letter for a specific job.
- list_my_cvs / set_primary_cv — manage uploaded CVs.

What UPply itself offers — steer the user to these features, do not send them elsewhere:
- Job search — the search bar at the top of the home page (you also have search_jobs / find_matching_jobs).
- AI job-fit analysis — the "Analyze" button on every job card (you also have analyze_job_fit).
- Saving jobs and tracking applications with a status pipeline (saved -> applied -> interview -> offer).
- CV upload with AI auto-fill of the profile — Account page.
- AI Cover Letter generator — Account page, "Cover letter" quick action (you can also do it here with draft_cover_letter).
- AI Mock Interview — Account page, "Mock interview" quick action: a 5-question role-specific practice interview in English or Hebrew, the interviewer speaks, and it ends with a scored report. You cannot run it from chat, so point the user there.
- Activity history and stats (applications, interviews, response rate) — Account page.

How to work:
- Prefer doing the task with tools over telling the user where to click. If they
  ask to find and save React jobs, search and save them.
- The user is inside UPply. When your advice involves something UPply already
  does — practising interviews, analysing a job, writing a cover letter, tracking
  applications, searching jobs — recommend UPply's own feature (name it and say
  where it is), or just do it with a tool. Only mention an external site or tool
  as an extra, never as the primary suggestion. Example: for interview practice,
  point them to the Mock Interview on the Account page, not to LeetCode mocks or
  "practice with peers".
- ALWAYS judge jobs against the candidate profile and CV above. Match seniority
  to their years of experience and current title — do NOT save or recommend
  "Senior" / "Lead" / "Staff" / "Principal" roles for a junior or entry-level
  candidate, and don't push a senior candidate toward junior roles. Weigh their
  actual skills against the job's requirements.
- When the user asks you to find jobs that fit THEM — "most relevant jobs for
  me", "jobs that match my profile", "roles that fit my background" — do NOT
  search one exact title. Use find_matching_jobs: read their profile, CV, skills
  and career goals and infer 3–6 related job titles that a person with this
  background would realistically apply to, varying the seniority and the
  sub-role. E.g. for a software-development internship:
  "software engineer intern", "student software developer", "junior developer",
  "backend intern", "full stack intern". Pass them all in one call.
- Use search_jobs only when the user named ONE specific title/keyword to look
  for. Keep its keywords SHORT — a role plus at most one modifier ("frontend
  developer", "junior data analyst"). Both tools are keyword searches: every
  word must appear in the posting, so NEVER pass a skill list or several
  seniority words in one string. Put the place in the location argument.
- If results are still thin, broaden and search again before giving up: drop
  "intern" / "junior", use the plain role, widen the location (city then
  country), or try student/graduate-programme wording. Entry-level pools are
  small.
- When you do have results, RANK them yourself against the profile/CV (seniority
  fit, skill overlap, location, work-mode and salary preferences) and briefly say
  why the ones you chose fit before saving them. If the choice hinges on one
  specific posting, you may call analyze_job_fit on it — but not more than 2 per
  turn (it is slow).
- If, after broadening, nothing genuinely fits their level, say so honestly and
  suggest concrete next search terms instead of saving a poor fit.
- Before any action that changes stored data (updating the profile, saving or
  un-saving a job, tracking an application, changing a status or the primary CV),
  briefly confirm with the user first — UNLESS their message was already an
  explicit instruction to do exactly that.
- When the user's message IS an explicit instruction ("save them", "save the best
  3", "apply", "update my..."), you MUST make the tool call in this same turn.
  Do the searches, then call save_job for each chosen job (all the save_job calls
  together, in one step). NEVER answer with "I will save them", "saving now" or
  "I've saved them" unless the save_job calls actually happened this turn — the
  user can see their activity list and will know if nothing was saved.
- Only call track_application after the user confirms they actually submitted the
  application. Applying happens on the employer's site, which you cannot do.
- When you save or apply to jobs from a search, use the exact job_url from the
  search results.
- After acting, tell the user plainly what you did and why those jobs fit them.
- The profile context above is a snapshot from the start of the turn; call
  get_my_profile / get_my_activity again if you need the current state.
- Be warm, encouraging and professional.

Formatting:
- Keep replies concise (3–5 short paragraphs max).
- When listing jobs, use ONE flat bullet per job in this shape:
  "**Job Title** — Company, Location. Short reason it fits you. [Apply](url)"
- Never nest bullets or add sub-bullets under a job. Never paste a raw URL —
  always write it as a markdown link like [Apply](https://…).
- Use plain "-" for bullets and "**text**" for bold; no other markdown.`;

  const convo = [
    { role: "system", content: systemPrompt },
    ...history.slice(-10),
    { role: "user", content: message },
  ];

  const actionsTaken = [];   // [{ label, mutating }]
  const toolTrace    = [];   // [{ tool, ok }]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msg = await callOpenAIRaw(CHAT_MODEL, convo, {
      tools: TOOLS,
      toolChoice: "auto",
      maxTokens: 550,
      temperature: 0.6,
    });
    convo.push(msg);

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      log("info", "Chat reply generated", { user_id: userId, rounds: round, actions: actionsTaken.length });
      return {
        reply: (msg.content || "").trim(),
        actions_taken: actionsTaken.map((a) => a.label),
        did_mutate: actionsTaken.some((a) => a.mutating),
      };
    }

    const runCall = async (tc) => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* keep {} */ }

      let result;
      let success = true;
      try {
        result = await executeTool(userId, tc.function.name, args);
        if (result && result.error) success = false;
      } catch (err) {
        success = false;
        result = { error: err.message };
      }

      toolTrace.push({ tool: tc.function.name, ok: success });
      if (success) {
        const label = TOOL_LABELS[tc.function.name]?.(args) ?? tc.function.name;
        actionsTaken.push({ label, mutating: MUTATING_TOOLS.has(tc.function.name) });
      }
      log("info", "Agent tool call", { user_id: userId, tool: tc.function.name, ok: success });

      return {
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result ?? {}),
      };
    };

    // Read-only calls can run in parallel; writes (save_job, track_application,
    // profile updates …) run one at a time — a burst of parallel writes trips the
    // sibling Lambda's concurrency limit on the AWS Academy lab.
    const writes = calls.filter((c) => MUTATING_TOOLS.has(c.function.name));
    const reads  = calls.filter((c) => !MUTATING_TOOLS.has(c.function.name));
    const toolMessages = [];
    toolMessages.push(...await Promise.all(reads.map(runCall)));
    for (const w of writes) toolMessages.push(await runCall(w));

    // Keep the model's tool replies in the same order it asked, so tool_call_id
    // pairing stays clean.
    const order = new Map(calls.map((c, i) => [c.id, i]));
    toolMessages.sort((a, b) => order.get(a.tool_call_id) - order.get(b.tool_call_id));

    convo.push(...toolMessages);
  }

  // Ran out of tool rounds — force a final answer with no more tools. Tell the
  // model exactly what it did and did NOT do so it can't claim un-run actions.
  const doneList = actionsTaken.length
    ? actionsTaken.map((a) => `- ${a.label}`).join("\n")
    : "- (nothing yet)";
  convo.push({
    role: "system",
    content:
      `You are out of tool calls for this turn. Actions actually completed:\n${doneList}\n\n` +
      `Write the final reply now. Only state what is in that list as done. If the ` +
      `user asked you to save or apply and it is NOT in the list, say plainly that ` +
      `you found the jobs but have not saved them yet and will do it if they confirm ` +
      `— do NOT write "I've saved" or "saving now".`,
  });
  const finalMsg = await callOpenAIRaw(CHAT_MODEL, convo, { maxTokens: 600, temperature: 0.5 });
  log("info", "Chat reply generated (max rounds)", { user_id: userId, actions: actionsTaken.length });
  return {
    reply: (finalMsg.content || "").trim() ||
      "I ran out of steps before finishing — tell me which part to pick up and I'll continue.",
    actions_taken: actionsTaken.map((a) => a.label),
    did_mutate: actionsTaken.some((a) => a.mutating),
  };
}

// ── Mode: analyze_job ─────────────────────────────────────────────────────────

async function handleAnalyzeJob(userId, job) {
  log("info", "Job analysis request", { user_id: userId, job_title: job.title, company: job.company });
  const profile = await fetchProfile(userId);

  const systemPrompt = `You are an expert career advisor and recruiter. Analyze job fit objectively and
strictly. Do NOT be encouraging at the expense of accuracy — a wrong "good match"
wastes the candidate's time.
Return ONLY a valid JSON object — no markdown fences, no text before or after the JSON.`;

  const userPrompt = `${profileContext(profile, { total: 0 })}

Job Posting:
  Title:       ${job.title       || "Unknown"}
  Company:     ${job.company     || "Unknown"}
  Location:    ${job.location    || "Unknown"}
  Description: ${(job.description || "Not provided").slice(0, 2500)}

Scoring rules — apply these BEFORE looking at skills:

1. HARD BLOCKER → fit_score MUST be 15-30, verdict MUST be "Weak match", and the
   blocker MUST be the first item in "gaps". This overrides everything else.
   A hard blocker exists when ANY of these is true:
   - the posting requires citizenship / work authorization / a visa / a security
     clearance / a professional licence, and the candidate's profile gives no
     indication they hold it. Treat "requirement stated, candidate silent" as
     NOT met — do not assume they might qualify.
   - the role is on-site or hybrid in a country different from the candidate's
     stated location, and the posting does not explicitly offer relocation or
     visa sponsorship. (Needing to move countries and get a visa is a blocker,
     not a "gap to address".)
   - a mandatory degree / certification / minimum years of experience the
     candidate plainly does not have.
   Example: candidate is in Israel; job is "on-site in Virginia, must be eligible
   to work in the US" → hard blocker → score ~20, "Weak match".

2. No hard blocker but a big SENIORITY mismatch (Senior/Lead/Staff/Principal role,
   junior or student candidate) → fit_score stays 25-50.

3. Otherwise score normally on skill overlap, seniority fit, location and
   work-mode preferences.

Return JSON with exactly these keys:
{
  "fit_score": <integer 0–100>,
  "verdict": "<one of: Excellent match | Strong match | Good match | Moderate match | Weak match>",
  "strengths": ["<max 3 specific strengths based on the profile vs job>"],
  "gaps": ["<max 3 specific gaps or missing requirements; a hard blocker goes first>"],
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

// ── Mode: cover_letter ───────────────────────────────────────────────────────

async function handleCoverLetter(userId, job, { emphasis, tone } = {}) {
  log("info", "Cover letter request", { user_id: userId, job_title: job.title, company: job.company });

  const [profile, cvText] = await Promise.all([
    fetchProfile(userId),
    fetchPrimaryCV(userId),
  ]);

  const cvSection = cvText
    ? `\nCandidate's CV (full text):\n---\n${cvText.slice(0, 6000)}\n---`
    : "\n(No CV on file — write from the profile fields only.)";

  const systemPrompt = `You write concise, specific, genuine cover letters for job applications.
You never invent experience the candidate does not have. Output plain text only —
no markdown, no placeholders like [Your Name] or [Company Address].`;

  const userPrompt = `${profileContext(profile, { total: 0 })}
${cvSection}

Target job:
  Title:       ${job.title       || "the role"}
  Company:     ${job.company     || "the company"}
  Description: ${(job.description || "Not provided").slice(0, 3000)}

Tone: ${tone || "professional, warm, confident"}
${emphasis ? `The candidate specifically wants to emphasise: ${emphasis}` : ""}

Write the cover letter:
- Keep it SHORT: 3 tight paragraphs, 150–200 words total. A recruiter should be
  able to read it in 20 seconds. Cut anything generic.
- Start at the salutation ("Dear Hiring Manager," unless the description names a better one). No address block, no date.
- Para 1 (1–2 sentences): specific interest in THIS company/role — never "I am writing to apply for".
- Para 2: the 2–3 most relevant concrete achievements / skills from the CV / profile that match this job. No lists of everything — just the strongest matches.
- Para 3 (1–2 sentences): a forward-looking close and one sentence inviting an interview.
- If there is an obvious gap (e.g. junior vs. the posting), a single positive clause is enough — do not dwell on it.
- End with "Sincerely," and the candidate's full name on the next line.
- Plain text only — no markdown, and no trailing spaces at the end of lines.
- Return ONLY the letter text.`;

  const raw = await callOpenAI(CHAT_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt },
  ], 450, 0.6);

  // Strip trailing whitespace (markdown hard-break "  \n") and collapse >2 blank lines.
  const text = raw
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  log("info", "Cover letter generated", { user_id: userId, length: text.length });
  return { cover_letter: text };
}

// ── Mode: tailor_resume ──────────────────────────────────────────────────────
//
// Rewrites the user's PRIMARY CV to fit one specific job — reorder / rephrase /
// re-emphasise only, never invent. Returns { has_cv: false } when there's no CV
// on file so the client can tell the user to upload one.

async function handleTailorResume(userId, job) {
  log("info", "Tailor resume request", { user_id: userId, job_title: job.title, company: job.company });

  const [profile, cvText] = await Promise.all([
    fetchProfile(userId),
    fetchPrimaryCV(userId),
  ]);

  if (!cvText || !cvText.trim()) {
    return { has_cv: false };
  }

  const systemPrompt = `You are an expert resume writer. You take an existing resume and rewrite it so
it is tailored to ONE specific job — without inventing anything.

Hard rules:
- Use ONLY facts already in the original resume: employers, job titles, dates,
  education, projects, skills, tools, certifications, responsibilities,
  achievements. Never add a skill, technology, employer, project, metric or
  responsibility that is not already present.
- What you MAY do: reorder sections and bullets so the most job-relevant content
  comes first; rephrase bullets to use the target job's language where the
  underlying fact already supports it; expand a relevant bullet using detail
  already implied by the original; shorten or drop content that doesn't matter
  for this role; write a 2–3 line summary at the top drawn from real content.
- Emphasise what the job asks for: e.g. a software role → programming languages,
  development projects, technical experience; a cloud role → AWS/Azure/GCP,
  infrastructure, cloud projects. Only if those things are already in the resume.
- Output: clean plain text, uppercase section headers (SUMMARY, SKILLS,
  EXPERIENCE, PROJECTS, EDUCATION — use only the ones that apply), simple
  "- " bullets. No markdown, no tables, no invented numbers.
Return ONLY the tailored resume text.`;

  const userPrompt = `TARGET JOB
  Title:       ${job.title       || "the role"}
  Company:     ${job.company     || "the company"}
  Description:
${(job.description || "Not provided").slice(0, 3000)}

${profileContext(profile, { total: 0 })}

ORIGINAL RESUME — this is the ONLY source of truth, do not go beyond it:
---
${cvText.slice(0, 9000)}
---

Rewrite this resume tailored to the target job, following every rule above. Lead
with the experience, skills, projects and technologies that best match this
job's requirements.`;

  const raw = await callOpenAI(CHAT_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt },
  ], 1800, 0.4);

  const resume = raw
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  log("info", "Tailored resume generated", { user_id: userId, length: resume.length });
  return { has_cv: true, resume };
}

// ── Mode: interview ──────────────────────────────────────────────────────────
//
// One stateless turn of a practice interview. The client keeps the transcript
// and sends it back each turn:
//   transcript = [{ question, answer }, ...]  (only fully-answered pairs)
//   target     = how many questions this round runs to (default 5; grows when
//                the user asks to keep going)
//   focus      = "balanced" | "technical" | "behavioral"
//   resume     = true when continuing after a report — no new answer to grade
// The Lambda returns the next question, or — once `target` questions have been
// answered — a report covering the whole interview so far.

const INTERVIEW_QUESTIONS = 5;

const FOCUS_GUIDE = {
  balanced:
    "Balanced mix: a short warm-up, then behavioural (STAR) questions and role-specific / technical questions in roughly equal measure; near the end invite the candidate's own questions.",
  technical:
    "Technical focus: after a short warm-up, ask mostly role-specific and technical questions — problem-solving, technologies named in the job description, design/architecture thinking, debugging, trade-offs. Keep behavioural questions to a minimum.",
  behavioral:
    "Behavioural / HR focus: after a short warm-up, ask mostly behavioural and situational questions of the kind a recruiter or people-team screen uses — teamwork, conflict, handling pressure, motivation, strengths and weaknesses, career goals. Expect STAR-style answers; avoid deep technical content.",
};

async function handleInterview(userId, job, transcript = [], opts = {}) {
  const language = opts.language === "he" ? "he" : "en";
  const focus    = FOCUS_GUIDE[opts.focus] ? opts.focus : "balanced";
  const target   = Math.max(1, Math.min(20, Number(opts.target) || INTERVIEW_QUESTIONS));
  const resume   = !!opts.resume;

  const answered = transcript.length;
  const isFirst  = answered === 0;
  const isFinal  = !resume && answered >= target;

  log("info", "Interview turn", { user_id: userId, job_title: job.title, answered, target, focus, resume, isFinal, language });

  const [profile, cvText] = await Promise.all([
    fetchProfile(userId),
    fetchPrimaryCV(userId),
  ]);
  const cvSection = cvText
    ? `\nCandidate CV:\n---\n${cvText.slice(0, 4000)}\n---`
    : "\n(No CV on file — use the profile only.)";

  const langLine = language === "he"
    ? "IMPORTANT: conduct the entire interview in Hebrew — every question, all feedback, and the whole report must be written in natural Hebrew."
    : "Conduct the interview in English.";

  const systemPrompt = `You are a friendly but rigorous hiring interviewer at ${job.company || "the company"},
running a practice interview for the role of ${job.title || "the role"}.
${langLine}
${FOCUS_GUIDE[focus]}
Ask ONE question at a time. Match difficulty to the job description and the
candidate's experience level. Never repeat a question already asked.

Grade what was ACTUALLY written — never invent content:
- Base every piece of feedback strictly on the candidate's literal words. Do not
  credit them with clarity, passion, examples, structure, or anything else the
  answer doesn't actually contain.
- If the answer is empty, gibberish, a placeholder ("bla bla bla", "test",
  keyboard mashing), just a few words, or doesn't address the question at all,
  say so plainly — e.g. "That didn't really answer the question — you'll want
  to give a real example here" — and do NOT praise it or pretend it was
  helpful. A non-answer gets zero credit, not polite encouragement.
- It is fine, and expected, to be critical when the answer earns it. Politeness
  should never turn into fabricating substance that isn't there.
Return ONLY a valid JSON object — no markdown fences, no text outside the JSON.
The JSON keys stay in English; only the string values follow the interview language.`;

  const contextBlock = `Role: ${job.title || "?"} at ${job.company || "?"}
Job description: ${(job.description || "Not provided").slice(0, 2000)}

${profileContext(profile, { total: 0 })}${cvSection}`;

  const transcriptBlock = transcript.length
    ? transcript.map((t, i) => `Q${i + 1}: ${t.question}\nAnswer: ${t.answer}`).join("\n\n")
    : "(the interview has not started yet)";

  let task;
  if (isFirst) {
    task = `Start the interview. Return {"feedback": "", "question": "<a brief warm-up question>"}`;
  } else if (resume) {
    task = `The candidate wants to keep practising with more questions. Do NOT give feedback on
the previous answer again. Just ask the next question (question ${answered + 1}),
following the focus above and not repeating anything already asked.
Return {"feedback": "", "question": "<the next question>"}`;
  } else if (!isFinal) {
    task = `Look at the candidate's most recent answer above and grade it honestly against
what the question actually asked. Give short feedback (1–2 sentences, concrete):
if there's real substance, name specifically what worked and what to sharpen; if
the answer was weak, off-topic, or not a real attempt, say that directly instead
of inventing positives. Then ask question ${answered + 1} of ${target}.
Return {"feedback": "<honest feedback on the last answer>", "question": "<the next question>"}`;
  } else {
    task = `The candidate has answered ${answered} questions. Give brief, honest feedback on
the final answer (per the grading rules above), then produce an overall report
covering the whole interview so far. The score and summary must reflect actual
answer quality — if most answers were low-effort, off-topic, or non-answers,
the score should be low (well under 40) and the summary must say so plainly,
not soften it.
Return {"feedback": "<honest feedback on the last answer>", "report": {
  "score": <integer 0-100, overall interview performance>,
  "summary": "<2 sentences honestly summarising how it went>",
  "strengths": ["<2 concrete strengths actually evidenced in the answers — omit or say 'none demonstrated' if there aren't real ones>"],
  "improve": ["<2 concrete things to work on>"],
  "sample_answer": "<a stronger version of the candidate's weakest answer, 3-4 sentences>"
}}`;
  }

  const raw = await callOpenAI(CHAT_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user",   content: `${contextBlock}\n\nInterview so far:\n${transcriptBlock}\n\n${task}` },
  ], isFinal ? 550 : 320, 0.5);

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    log("error", "Interview JSON parse failed", { raw_snippet: raw.slice(0, 200) });
    throw new Error("The interviewer got confused — please try that answer again.");
  }

  return {
    feedback: result.feedback || "",
    question: result.question || null,
    report:   result.report   || null,
    number:   Math.min(answered + 1, target),
    total:    target,
    done:     !!result.report,
  };
}

// ── Mode: tts ────────────────────────────────────────────────────────────────
//
// Text → speech via OpenAI. Returns base64 mp3 the browser plays. Language is
// auto-detected from the text, so Hebrew input speaks Hebrew. Tries TTS_MODEL
// first (default gpt-4o-mini-tts), then falls back to tts-1.
//
// If the OpenAI key has no audio-model access (as with a restricted project
// key), set OPENAI_TTS_DISABLED=1 — this mode then returns empty audio with a
// 200, and the client speaks with the browser's built-in voice instead (no
// failed request, no error).

const TTS_VOICE   = process.env.TTS_VOICE || "alloy";
const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const TTS_DISABLED = /^(1|true|yes)$/i.test(process.env.OPENAI_TTS_DISABLED || "");
// Ordered list of models to try — first hit wins.
const TTS_MODELS = [...new Set([process.env.TTS_MODEL || "gpt-4o-mini-tts", "tts-1"])];

// Once we learn this key has no audio-model access, stop calling OpenAI for the
// life of the warm container and return empty audio (200) so the client uses its
// browser voice — no repeated 403s. (Survives until the container recycles.)
let ttsNoAccess = false;

async function handleTTS(text, voice) {
  if (TTS_DISABLED || ttsNoAccess) return { audio: "", format: "mp3", disabled: true };

  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY environment variable is not set");

  const input = (text || "").trim().slice(0, 1500);
  if (!input) return { audio: "", format: "mp3" };

  let lastError = "unknown error";
  for (const model of TTS_MODELS) {
    const res = await fetch(OPENAI_TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ model, voice: voice || TTS_VOICE, input, response_format: "mp3" }),
    });

    if (res.ok) {
      const audio = Buffer.from(await res.arrayBuffer()).toString("base64");
      log("info", "TTS generated", { model, chars: input.length, bytes: audio.length });
      return { audio, format: "mp3" };
    }

    lastError = `${res.status}: ${(await res.text()).slice(0, 200)}`;
    log("warn", "TTS model failed", { model, error: lastError });
  }

  // "does not have access to model" / 403 → this key will never do TTS. Latch it
  // off and answer softly instead of erroring on every question.
  if (/does not have access|\b403\b|model_not_found/i.test(lastError)) {
    ttsNoAccess = true;
    log("info", "TTS disabled for this container — no audio-model access on the key");
    return { audio: "", format: "mp3", disabled: true };
  }

  throw new Error(`OpenAI TTS failed (tried ${TTS_MODELS.join(", ")}): ${lastError}`);
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

  if (!mode) return bad("Missing mode");

  try {
    // tts is stateless and carries no user data — no user_id needed.
    if (mode === "tts") {
      if (!body.text) return bad("Missing text");
      const result = await handleTTS(body.text, body.voice);
      return ok(result);
    }

    if (!user_id) return bad("Missing user_id");

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

    if (mode === "cover_letter") {
      if (!job || !job.title) return bad("Missing job data");
      const result = await handleCoverLetter(user_id, job, { emphasis: body.emphasis, tone: body.tone });
      return ok(result);
    }

    if (mode === "tailor_resume") {
      if (!job || !job.title) return bad("Missing job data");
      const result = await handleTailorResume(user_id, job);
      return ok(result);
    }

    if (mode === "interview") {
      if (!job || !job.title) return bad("Missing job data");
      const transcript = Array.isArray(body.transcript) ? body.transcript : [];
      const result = await handleInterview(user_id, job, transcript, {
        language: body.language,
        focus:    body.focus,
        target:   body.target,
        resume:   body.resume,
      });
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
