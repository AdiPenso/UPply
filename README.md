# UPply

**Smart job-application platform — React SPA on a serverless AWS backend.**

UPply aggregates tech job listings from external providers, uses an LLM to score
how well each posting fits the user's profile, tracks saved jobs and
applications, and provides an AI career-coach chat. Final degree project for the
*Cloud Computing Workshop with AWS* — Meshi Barabi & Adi Penso.

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
| `jobs/` | `GET /jobs` | Job search — routes to **JSearch** (global) or **CareerJet** (Israel), normalizes both into one shape |
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
It calls the OpenAI Chat Completions API (`gpt-4.1-mini`) and dispatches on a
`mode` field in the POST body:

| `mode` | Called from (frontend) | What it does |
|---|---|---|
| `chat` | `AIChatPanel.jsx` via `askAI()` | Career-coach chat. Loads the user's profile, **primary** CV text and activity count from DynamoDB, builds a system prompt, sends the last ~10 messages as history. |
| `analyze_job` | `HomePage.jsx` analysis modal via `analyzeJobFit()` | Compares profile ↔ job description, returns JSON: `fit_score` (0–100), `verdict`, `strengths`, `gaps`, `recommendations`, `key_requirements`. |
| `extract_cv` | `AccountPage.jsx` CV upload via `extractCV()` | Parses CV text into structured profile fields (title, skills, years of experience, summary, …). |

Helpers in that file: `fetchProfile`, `fetchPrimaryCV`, `fetchActivityCounts`
(DynamoDB reads), `callOpenAI` (HTTP), `profileContext` (formats the profile for
the prompt). Responses that must be JSON are parsed defensively (markdown-fence
stripping + `try/catch`).

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
| `ai` | `OPENAI_API_KEY`, `USERS_TABLE`, `ACTIVITY_TABLE`, `DOCUMENTS_TABLE` |
| `jobs` | `RAPIDAPI_KEY`, `CAREERJET_AFFID`, `CAREERJET_AFFILIATE_URL` |
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
| AI | OpenAI API (`gpt-4.1-mini`) |
| External data | JSearch (RapidAPI), CareerJet |
| Monitoring | Amazon CloudWatch |
| Region | `us-east-1` |

---

## Notes for reviewers

- **API auth:** the Lambdas take `user_id` from the request and do not verify a
  Cognito token; the client sends no `Authorization` header. Adding an API
  Gateway Cognito authorizer is the main planned hardening step.
- **CORS** is currently open (`Access-Control-Allow-Origin: *`) on all functions.
- `AccountPage.jsx` is large (~2k lines) — a candidate for splitting, kept as-is
  to avoid churn before submission.
- Lambda `package-lock.json` files are git-ignored (deps are installed locally
  before zipping); `@aws-sdk/*` v3 is provided by the Lambda runtime.
