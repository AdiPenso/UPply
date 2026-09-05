# UPply — Backend (AWS Lambda)

Nine independent Lambda functions behind a single Amazon API Gateway, all in
`us-east-1`. Each folder here is a self-contained npm package with an `index.mjs`
handler (ES module).

## Conventions

Every handler shares the same structure:

- a `CORS` headers constant (`Access-Control-Allow-Origin: *`),
- `ok(body)` / `bad(msg, code)` response helpers,
- a structured `log(level, msg, extra)` helper that prints one JSON object per
  line (picked up by CloudWatch Logs),
- an `OPTIONS` short-circuit for CORS preflight.

`@aws-sdk/*` v3 is provided by the Lambda Node.js runtime. Folders still list it
in `package.json` for local installs; `jobs` needs no dependencies (it uses the
global `fetch`).

## Functions

| Folder | Route | Methods | Summary |
|---|---|---|---|
| `profile-get` | `/profile` | GET | Read a profile by `user_id`; returns `{ exists, ...fields }` |
| `profile-post` | `/profile` | POST | Create a profile on first login |
| `profile-update` | `/profile` | PUT | Update a whitelisted subset of profile fields |
| `jobs` | `/jobs` | GET | Search jobs; routes to JSearch or CareerJet |
| `user-activity-get` | `/activity` | GET | Return `{ saved, applied, ... }` for a user |
| `user-activity-track` | `/activity` | POST | `save` / `unsave` / `apply` / `update_status` / `delete` |
| `upload-url` | `/upload-url` | POST | Presigned S3 PUT URL for a CV upload |
| `documents` | `/documents` | GET, POST | CV metadata list / save / set-primary / delete + presigned download |
| `ai` | `/ai` | POST | AI features, dispatched on `mode` (`chat` — agentic, invokes the other Lambdas as tools / `analyze_job` / `extract_cv`) |

### Request shapes (quick reference)

```
GET  /profile?user_id=<sub>
POST /profile            { user_id, email, first_name, last_name, phone?, location? }
PUT  /profile            { user_id, ...anyWhitelistedFields }

GET  /jobs?keywords=<kw>&location=<loc>&page=<n>        (10 results / page)

GET  /activity?user_id=<sub>
POST /activity           { user_id, action, job? , activity_id?, status? }

POST /upload-url         { user_id, file_name }         -> { upload_url, s3_key }
GET  /documents?action=list&user_id=<sub>
GET  /documents?action=download_url&user_id=<sub>&doc_id=<id>
POST /documents          { user_id, action: save|set_primary|delete, ... }

POST /ai                 { user_id, mode: "chat",         message, history }
                           -> { reply, actions_taken: [string], did_mutate: bool }
POST /ai                 { user_id, mode: "analyze_job",  job }
POST /ai                 { user_id, mode: "cover_letter",  job, emphasis? }  -> { cover_letter }
POST /ai                 { user_id, mode: "tailor_resume", job }  -> { has_cv: false } | { has_cv: true, resume }
POST /ai                 { user_id, mode: "interview",    job, transcript: [{question,answer}],
                            language: "en"|"he", focus: "balanced"|"technical"|"behavioral",
                            target?, resume? }
                           -> { feedback, question, number, total, done, report? }
POST /ai                 {          mode: "tts",          text, voice? }  -> { audio (base64 mp3), format }
POST /ai                 { user_id, mode: "extract_cv",   cv_text }
```

### AI agent (`mode: "chat"`)

`chat` runs an OpenAI tool-calling loop (max `MAX_TOOL_ROUNDS`, default 6). The
model's tools each invoke a sibling Lambda through `@aws-sdk/client-lambda`
(`InvokeCommand`, `RequestResponse`) with a synthetic API-Gateway proxy event;
the `{ statusCode, body }` envelope is unwrapped back into a plain object. The
caller's `user_id` is injected into every tool call server-side, so the agent can
only ever act on the signed-in user's data.

| Tool | Invokes | Kind |
|---|---|---|
| `search_jobs` | `jobs` | read |
| `find_matching_jobs` | `jobs` ×N (3–6 inferred title searches, merged + de-duped) | read |
| `get_my_profile` / `update_my_profile` | `profile-get` / `profile-update` | read / write |
| `get_my_activity` | `user-activity-get` | read |
| `save_job` / `unsave_job` / `track_application` / `update_application_status` | `user-activity-track` | write |
| `analyze_job_fit` | in-process (`analyze_job`) | read |
| `draft_cover_letter` | in-process (`cover_letter`) | read |
| `list_my_cvs` / `set_primary_cv` | `documents` | read / write |

No delete tool is exposed. The system prompt tells the agent to confirm before
any write unless the user already gave an explicit instruction.

`profile-update` whitelist: `first_name, last_name, phone, location, title,
years_experience, desired_role, desired_salary_min, desired_salary_max,
work_mode, bio, skills`.

## Environment variables

Set per function in the Lambda console. Table / bucket names have defaults in
code, shown in parentheses.

| Function | Variables |
|---|---|
| `ai` | `OPENAI_API_KEY` (required), `USERS_TABLE` (`Users`), `ACTIVITY_TABLE` (`UserActivity`), `DOCUMENTS_TABLE` (`UserDocuments`), `MAX_TOOL_ROUNDS` (`6`), `AI_CHAT_MODEL` (`gpt-4.1-mini`), `AI_JSON_MODEL` (`gpt-4.1-mini`), `AI_REASONING_EFFORT` (`minimal` — only used if a model is a GPT-5/o), `OPENAI_TTS_DISABLED` (unset; `1` to skip OpenAI TTS entirely → browser voice. Even without it, the Lambda latches TTS off for the container after the first "no model access" 403), `TTS_MODEL` (`gpt-4o-mini-tts`), `TTS_VOICE` (`alloy`), `FN_JOBS` (`jobs-multi-source-search`), `FN_ACTIVITY_GET` (`user-activity-get`), `FN_ACTIVITY_TRACK` (`user-activity-track`), `FN_PROFILE_GET` (`getUserProfile`), `FN_PROFILE_UPDATE` (`profile-update`), `FN_DOCUMENTS` (`upply-documents`) — FN_* defaults match the current deployment |
| `jobs` | `RAPIDAPI_KEY` (required — JSearch, used globally and as the Israel fallback), `CAREERJET_API_KEY` (recommended — CareerJet v4 publisher key), `CAREERJET_LOCALE` (`en_GB`), `CAREERJET_AFFID` / `CAREERJET_AFFILIATE_URL` (legacy path only) |
| `documents` | `DOCUMENTS_TABLE` (`UserDocuments`), `BUCKET_NAME` (`upply-resumes`) |
| `upload-url` | `BUCKET_NAME` (`upply-resumes`) |
| `profile-get` / `profile-post` / `profile-update` | `USERS_TABLE` (`Users`) |
| `user-activity-get` / `user-activity-track` | `ACTIVITY_TABLE` (`UserActivity`) |

## DynamoDB tables

| Table | Partition key | Sort key | Notes |
|---|---|---|---|
| `Users` | `user_id` (S) | — | One item per user. Profile fields + `created_at` / `updated_at`. |
| `UserActivity` | `user_id` (S) | `activity_id` (S) | `save#<base64url(job_url)>` — deterministic, so `unsave` deletes the same key. `apply#<ISO ts>#<base64url(job_url)>` — event log, multiple allowed. `status` in `applied\|interview\|offer\|accepted\|rejected`. |
| `UserDocuments` | `user_id` (S) | `doc_id` (S) | `s3_key`, `file_name`, `cv_text`, `is_primary` (bool), `uploaded_at`. Exactly one item per user has `is_primary = true`. |

No secondary indexes — every read is a `Get` or a `Query` on the keys above.

## S3

Bucket `upply-resumes`, private. Objects are written only via presigned PUT URLs
(`upload-url`) and read only via presigned GET URLs (`documents`, 5-min expiry).
Key format: `users/<user_id>/<timestamp>_<sanitised_filename>.pdf`.

## Deploy

There is no IaC. Each function is deployed by zipping its folder and uploading:

```bash
cd backend/lambdas/<name>
npm install            # only where package.json lists dependencies
zip -r function.zip .  # index.mjs + node_modules (if any)

# then, either:
aws lambda update-function-code \
  --function-name <deployed-function-name> \
  --zip-file fileb://function.zip \
  --region us-east-1
# or upload function.zip in the Lambda console.
```

`function.zip` and `node_modules/` are git-ignored.

### Extra setup for the `ai` agent

The `chat` agent invokes six sibling Lambdas, so its function needs more than the
default config:

1. **IAM** — the `ai` execution role must allow `lambda:InvokeFunction` on the
   six sibling functions (`jobs-multi-source-search`, `user-activity-get`,
   `user-activity-track`, `getUserProfile`, `profile-update`, `upply-documents`).
   The shared AWS Academy `LabRole` already grants this, so no change is needed
   there; add an inline policy only if the role is more tightly scoped.
2. **Timeout** — raise the `ai` function timeout to **29 s** (API Gateway's
   integration ceiling) so multi-step tool loops can finish.
3. **Env vars** — only needed if a function is renamed; the `FN_*` defaults in
   code match the current deployment.
4. **Dependency** — `ai` now also uses `@aws-sdk/client-lambda` (provided by the
   Node 20 runtime; listed in `package.json` for local installs).

## Related AWS resources (not in this repo)

- **API Gateway** — one REST API mapping the routes above to these functions.
- **Amazon Cognito** — user pool for sign-up / sign-in (frontend only).
- **CloudWatch** — log group per function; logs are structured JSON.
- **IAM** — an execution role per function, scoped to the tables / bucket it
  uses. The `ai` role additionally needs `lambda:InvokeFunction` on the six
  sibling functions its agent tools call.
