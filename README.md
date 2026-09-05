# UPply

**Smart job-application platform — React SPA on a serverless AWS backend.**

UPply aggregates tech job listings from external providers, uses an LLM to score
how well each posting fits the user's profile, tracks saved jobs and
applications, and provides an **AI career agent** — a chat assistant that can
search jobs, save/apply to them, edit the profile and analyse fit on its own by
invoking the other Lambdas as tools. Final degree project for the *Cloud
Computing Workshop with AWS* — Meshi Barabi & Adi Penso.

This README is a **guide to the codebase**: where things live and how the pieces
fit together. For the product story, see the presentation and poster.

---

## Repository layout

```
UPply/
├── client/                  Frontend — React 19 + Vite 8 single-page app
│   ├── index.html               HTML entry point (loads src/main.jsx)
│   ├── .env.example             Frontend config template (copy to .env)
│   ├── vite.config.js
│   ├── eslint.config.js
│   └── src/
│       ├── main.jsx             App bootstrap: configures Amplify, mounts <App/>
│       ├── App.jsx              Route table (react-router)
│       ├── aws/config.js        Cognito + API Gateway config (from env vars)
│       ├── services/api.js      *** every backend call is defined here ***
│       ├── utils/extractPDFText.js   Client-side PDF → text (pdf.js)
│       ├── pages/               One component per route
│       └── components/          Header, AIChatPanel
│
├── backend/
│   └── lambdas/                 One folder per AWS Lambda (9 functions)
│       ├── <name>/
│       │   ├── index.mjs        Handler (ES module)
│       │   └── package.json     Per-function dependencies
│       └── README.md            *** routes, env vars, table schemas, deploy ***
│
├── .github/workflows/ci.yml     Lint + build the client on push / PR
├── package.json                 Convenience scripts that pass through to client/
├── LICENSE
└── README.md
```

The root `package.json` has no dependencies of its own. `client/` and each
`backend/lambdas/<name>/` are independent npm packages.

---

## Frontend

### Entry points & routing

`client/index.html` → `client/src/main.jsx` (calls `Amplify.configure()` then
renders `<App/>`) → `client/src/App.jsx` defines all routes:

| Route | Page component | Purpose |
|---|---|---|
| `/` | `OnboardingPage.jsx` | Landing screen |
| `/login` | `LoginPage.jsx` | Cognito sign-in |
| `/register` | `RegisterPage.jsx` | Cognito sign-up |
| `/confirm-signup` | `ConfirmSignUpPage.jsx` | Email confirmation code |
| `/complete-profile` | `CompleteProfilePage.jsx` | First-login profile creation |
| `/home` | `HomePage.jsx` | Job search feed, job-fit analysis, AI coach |
| `/account` | `AccountPage.jsx` | Profile editing, CV management, activity history |

There is no route guard component — pages call `fetchAuthSession()` from
`aws-amplify/auth` themselves and redirect if there is no session.

Styling is done with inline JS style objects inside each component.
`client/src/index.css` only holds a global reset and three shared keyframe
animations (chat typing dots, skeleton shimmer, spinner).

### How the frontend talks to the backend

**All HTTP calls to the backend live in one file: [`client/src/services/api.js`](client/src/services/api.js).**
Pages import named functions from it and never call `fetch` directly. Each
function targets `API_BASE_URL` (from `aws/config.js`) + a path that maps to an
API Gateway route / Lambda.

| `api.js` function(s) | Method + path | Lambda |
|---|---|---|
| `getProfile` | `GET /profile` | `profile-get` |
| `createProfile` | `POST /profile` | `profile-post` |
| `updateProfile` | `PUT /profile` | `profile-update` |
| `fetchJobs` | `GET /jobs` | `jobs` |
| `getActivity` | `GET /activity` | `user-activity-get` |
| `postActivity`, `updateActivityStatus`, `deleteActivity` | `POST /activity` | `user-activity-track` |
| `getUploadUrl` | `POST /upload-url` | `upload-url` |
| `uploadFileToS3` | `PUT` (presigned S3 URL) | — (direct to S3) |
| `getDocuments`, `saveDocument`, `setPrimaryDocument`, `deleteDocument`, `getDownloadUrl` | `GET/POST /documents` | `documents` |
| `askAI`, `extractCV`, `analyzeJobFit` | `POST /ai` | `ai` |

Requests currently send no auth token — see **Notes for reviewers** below.

### Authentication

- Configured in `client/src/aws/config.js` (Cognito user-pool ID, app-client ID)
  and applied in `client/src/main.jsx` via `Amplify.configure(awsConfig)`.
- Sign-up / confirm / sign-in / sign-out use `aws-amplify/auth` directly in the
  auth pages.
- After login, the Cognito user id (`idToken.payload.sub`) is used as the
  `user_id` for all backend calls.

### CV handling (frontend side)

`client/src/utils/extractPDFText.js` extracts plain text from an uploaded PDF in
the browser with `pdfjs-dist` (first 6 pages). `AccountPage.jsx` then:
1. gets a presigned URL (`getUploadUrl`) and `PUT`s the file to S3
   (`uploadFileToS3`),
2. sends the extracted text to the AI (`extractCV`) to get structured fields,
3. saves metadata + text to DynamoDB (`saveDocument`).

---

## Backend

Nine independent Lambda functions in `backend/lambdas/`, fronted by one API
Gateway. Full detail (routes, request shapes, env vars, table schemas, deploy
steps) is in **[`backend/lambdas/README.md`](backend/lambdas/README.md)**. Summary:

| Folder | Route(s) | Responsibility |
|---|---|---|
| `profile-get/` | `GET /profile` | Read a user profile from DynamoDB `Users` |
| `profile-post/` | `POST /profile` | Create a profile on first login |
| `profile-update/` | `PUT /profile` | Update whitelisted profile fields |
| `jobs/` | `GET /jobs` | Job search — **CareerJet** for Israel (v4 API if `CAREERJET_API_KEY` set, else legacy), **JSearch** everywhere else and as the Israel fallback; normalizes, HTML-cleans and de-dups both into one shape |
| `user-activity-get/` | `GET /activity` | Read saved + applied jobs |
| `user-activity-track/` | `POST /activity` | Write `save` / `unsave` / `apply` / `update_status` / `delete` events |
| `upload-url/` | `POST /upload-url` | Generate a presigned S3 PUT URL for a CV |
| `documents/` | `GET/POST /documents` | CV metadata CRUD + presigned download / S3 delete |
| `ai/` | `POST /ai` | All AI features (see below) |

Every handler follows the same pattern: `CORS` header constant, `ok()` / `bad()`
response helpers, and a structured JSON `log()` helper that writes one JSON
object per line to CloudWatch.

### AI logic

**All AI code is in [`backend/lambdas/ai/index.mjs`](backend/lambdas/ai/index.mjs).**
It calls the OpenAI Chat Completions API and dispatches on a `mode` field in the
POST body. The language model is **`gpt-4.1-mini`** (the prompts are tuned for
it); `AI_CHAT_MODEL` / `AI_JSON_MODEL` env vars let you swap in a cheaper model
without a redeploy, and `callOpenAIRaw` handles GPT-5 / o-series parameter
differences (`max_completion_tokens`, no `temperature`, `reasoning_effort`) if
you do. Speech-to-text for the interview uses the **browser's Web Speech API**,
not OpenAI; the interviewer's voice tries OpenAI TTS and falls back to the
browser voice.

| `mode` | Called from (frontend) | What it does |
|---|---|---|
| `chat` | `AIChatPanel.jsx` via `askAI()` | **Agentic career assistant.** Loads the user's profile, **primary** CV text and activity count for context, then runs an OpenAI tool-calling loop (up to `MAX_TOOL_ROUNDS`, default 6). Returns `{ reply, actions_taken[], did_mutate }`. |
| `analyze_job` | `HomePage.jsx` analysis modal via `analyzeJobFit()` | Compares profile ↔ job description, returns JSON: `fit_score` (0–100), `verdict`, `strengths`, `gaps`, `recommendations`, `key_requirements`. |
| `cover_letter` | `AccountPage.jsx` "Cover letter" quick action via `generateCoverLetter()` | Writes a tailored cover letter (plain text, 150–200 words) from the profile + primary CV for a job `{ title, company, description }`, optional `emphasis`. Returns `{ cover_letter }`. |
| `tailor_resume` | `HomePage.jsx` — the "Tailor my resume" step shown when **Apply** is clicked, via `tailorResume()` | Rewrites the user's **primary CV** to fit one posting — reorders / rephrases / re-emphasises only, never invents. Returns `{ has_cv: false }` (client tells the user to upload one) or `{ has_cv: true, resume }` (plain text, previewed before the external redirect). |
| `interview` | `AccountPage.jsx` "Mock interview" quick action via `runInterviewTurn()` | One **stateless turn** of a practice interview — **English or Hebrew** (`language`), **balanced / technical / behavioral** (`focus`), default 5 questions (`target`, grows when the user asks to keep going — `resume: true` skips re-grading the last answer). Client sends `{ job, transcript: [{question, answer}], language, focus, target, resume }`; returns `{ feedback, question, number, total, done, report? }`. Reaching `target` returns a `report` (score, summary, strengths, improve, sample_answer) covering the whole interview so far; the UI then offers 3 more questions, optionally with a different focus. Answers typed or dictated (browser `SpeechRecognition`, `he-IL`/`en-US`). |
| `tts` | `AccountPage.jsx` interview voice via `synthesizeSpeech()` | Text → speech via OpenAI (`gpt-4o-mini-tts`). Returns `{ audio }` (base64 mp3) the browser plays. No `user_id` — stateless, no PII. Language auto-detected from the text. |
| `extract_cv` | `AccountPage.jsx` CV upload via `extractCV()` | Parses CV text into structured profile fields (title, skills, years of experience, summary, …). |

**Agent tools** (`chat` mode) — each one invokes a sibling Lambda via the AWS SDK
(`InvokeCommand`) with a synthetic API-Gateway event; `user_id` is always
injected server-side so the agent can only touch the caller's own data:

| Tool | Sibling Lambda | Kind |
|---|---|---|
| `search_jobs` | `jobs` | read |
| `get_my_profile` / `update_my_profile` | `profile-get` / `profile-update` | read / write |
| `get_my_activity` | `user-activity-get` | read |
| `save_job` / `unsave_job` / `track_application` / `update_application_status` | `user-activity-track` | write |
| `analyze_job_fit` | (in-process `analyze_job`) | read |
| `draft_cover_letter` | (in-process `cover_letter`) | read |
| `list_my_cvs` / `set_primary_cv` | `documents` | read / write |

The agent has no delete tool. It is prompted to confirm before any write unless
the user's message was already an explicit instruction. When a write happens
(`did_mutate`), `AIChatPanel` calls its `onDataChanged` prop so `HomePage`
refreshes the saved-jobs view.

Helpers in that file: `fetchProfile`, `fetchPrimaryCV`, `fetchActivityCounts`
(DynamoDB reads), `callOpenAIRaw` / `callOpenAI` (HTTP), `invokeLambda`
(sibling-Lambda calls), `executeTool` (tool dispatch), `profileContext` (formats
the profile for the prompt). Responses that must be JSON are parsed defensively
(markdown-fence stripping + `try/catch`).

The OpenAI key is read from `process.env.OPENAI_API_KEY` inside the Lambda and is
never exposed to the browser.

### Data & storage logic

- **DynamoDB** (3 tables) — accessed via `@aws-sdk/lib-dynamodb`:
  - `Users` — PK `user_id`. Written by `profile-post` / `profile-update`, read by
    `profile-get` and `ai`.
  - `UserActivity` — PK `user_id`, SK `activity_id`. `save#…` keys are
    deterministic (idempotent unsave); `apply#<ts>#…` keys are an event log.
    Written by `user-activity-track`, read by `user-activity-get` and `ai`.
  - `UserDocuments` — PK `user_id`, SK `doc_id`. Holds CV metadata + extracted
    text + `is_primary` flag. Managed by `documents`, read by `ai`.
- **S3** (`upply-resumes`) — raw CV PDFs. Never accessed publicly: `upload-url`
  issues presigned PUTs, `documents` issues presigned GETs and does deletes.
  Object keys are namespaced `users/<user_id>/<timestamp>_<filename>`.
- **External APIs** (from the `jobs` Lambda): JSearch (RapidAPI) and CareerJet.

---

## Configuration & environment variables

### Frontend — `client/.env` (git-ignored; template in `client/.env.example`)

| Variable | Description |
|---|---|
| `VITE_COGNITO_USER_POOL_ID` | Cognito user-pool ID |
| `VITE_COGNITO_USER_POOL_CLIENT_ID` | Cognito app-client ID |
| `VITE_API_BASE_URL` | API Gateway base URL |

`client/src/aws/config.js` throws on startup if any are missing. These values are
shipped to the browser and are not secrets; they live in env vars only to keep
the repo unpinned from one AWS account.

### Backend — per-Lambda environment variables (set in the Lambda console)

| Lambda | Variables |
|---|---|
| `ai` | `OPENAI_API_KEY`, `USERS_TABLE`, `ACTIVITY_TABLE`, `DOCUMENTS_TABLE`, `MAX_TOOL_ROUNDS` (opt), `TTS_MODEL` / `TTS_VOICE` (opt — interview voice), `FN_JOBS` / `FN_ACTIVITY_GET` / `FN_ACTIVITY_TRACK` / `FN_PROFILE_GET` / `FN_PROFILE_UPDATE` / `FN_DOCUMENTS` (opt — deployed names of the sibling Lambdas the agent invokes; code defaults match the current deployment) |
| `jobs` | `RAPIDAPI_KEY` (JSearch), `CAREERJET_API_KEY` (CareerJet v4 — recommended), `CAREERJET_LOCALE`, `CAREERJET_AFFID` / `CAREERJET_AFFILIATE_URL` (legacy path only) |
| `documents` | `DOCUMENTS_TABLE`, `BUCKET_NAME` |
| `upload-url` | `BUCKET_NAME` |
| `profile-get`, `profile-post`, `profile-update` | `USERS_TABLE` |
| `user-activity-get`, `user-activity-track` | `ACTIVITY_TABLE` |

Table / bucket names fall back to defaults in code (`Users`, `UserActivity`,
`UserDocuments`, `upply-resumes`). **Never commit real key values.**

---

## Running locally

Only the frontend runs locally; it talks to the deployed AWS backend.

```bash
cp client/.env.example client/.env    # then fill in the three values
npm run setup                         # installs client dependencies
npm run dev                           # http://localhost:5173
```

The root `package.json` has no dependencies — its scripts (`dev`, `build`,
`preview`, `lint`, `setup`) are pass-throughs to `client/`. You can also work
inside `client/` directly (`cd client && npm install && npm run dev`).

Other scripts:

```bash
npm run build             # production build → client/dist/
npm run preview           # serve the production build
npm run lint              # ESLint (also run in CI)
```

To work on the backend, see **[`backend/lambdas/README.md`](backend/lambdas/README.md)**.

---

## Tech stack

| Area | Choice |
|---|---|
| Frontend | React 19, Vite 8, React Router 7 |
| Auth | Amazon Cognito (via `aws-amplify` v6) |
| Hosting | AWS Amplify + CloudFront |
| API | Amazon API Gateway (REST) |
| Compute | AWS Lambda (Node.js 20, ES modules) |
| Database | Amazon DynamoDB |
| File storage | Amazon S3 |
| AI | OpenAI API (`gpt-4.1-mini`); browser Web Speech API for STT |
| External data | JSearch (RapidAPI), CareerJet |
| Monitoring | Amazon CloudWatch |
| Region | `us-east-1` |

---

## Notes for reviewers

- **API auth:** the Lambdas take `user_id` from the request and do not verify a
  Cognito token; the client sends no `Authorization` header. Adding an API
  Gateway Cognito authorizer is the main planned hardening step. The `ai` agent
  mitigates this for its own tools by always injecting `user_id` server-side —
  the model cannot direct a tool at another user's data.
- **Agent IAM:** the `ai` Lambda's execution role needs `lambda:InvokeFunction`
  on the six sibling functions it calls (already granted by the shared AWS
  Academy `LabRole`), and its timeout is raised to 29 s (the API Gateway
  ceiling) to allow multi-step tool loops.
- **CORS** is currently open (`Access-Control-Allow-Origin: *`) on all functions.
- `AccountPage.jsx` is large (~2k lines) — a candidate for splitting, kept as-is
  to avoid churn before submission.
- Lambda `package-lock.json` files are git-ignored (deps are installed locally
  before zipping); `@aws-sdk/*` v3 is provided by the Lambda runtime.
