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
| `ai` | `/ai` | POST | AI features, dispatched on `mode` (`chat` / `analyze_job` / `extract_cv`) |

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

POST /ai                 { user_id, mode: "chat",        message, history }
POST /ai                 { user_id, mode: "analyze_job", job }
POST /ai                 { user_id, mode: "extract_cv",  cv_text }
```

`profile-update` whitelist: `first_name, last_name, phone, location, title,
years_experience, desired_role, desired_salary_min, desired_salary_max,
work_mode, bio, skills`.

## Environment variables

Set per function in the Lambda console. Table / bucket names have defaults in
code, shown in parentheses.

| Function | Variables |
|---|---|
| `ai` | `OPENAI_API_KEY` (required), `USERS_TABLE` (`Users`), `ACTIVITY_TABLE` (`UserActivity`), `DOCUMENTS_TABLE` (`UserDocuments`) |
| `jobs` | `RAPIDAPI_KEY` (required for global search), `CAREERJET_AFFID` (`upply_aws_project`), `CAREERJET_AFFILIATE_URL` |
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

## Related AWS resources (not in this repo)

- **API Gateway** — one REST API mapping the routes above to these functions.
- **Amazon Cognito** — user pool for sign-up / sign-in (frontend only).
- **CloudWatch** — log group per function; logs are structured JSON.
- **IAM** — an execution role per function, scoped to the tables / bucket it uses.
