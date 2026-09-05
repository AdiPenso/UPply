// UPply — /jobs Lambda
// Routes searches to JSearch (US/UK/global) or CareerJet (Israel). Israel is
// detected from the location string by country name OR by a major city name.
// CareerJet uses the v4 API when CAREERJET_API_KEY is set, else the (dying)
// legacy endpoint; either way it falls back to JSearch (country=il) on failure
// or empty results. CareerJet results are HTML-cleaned and de-duplicated.
// Supports pagination: pass ?page=N (1-based, 10 results per page).
//
// Env vars:
//   RAPIDAPI_KEY             — JSearch key (required for non-Israel search)
//   CAREERJET_API_KEY        — CareerJet v4 publisher key (recommended)
//   CAREERJET_LOCALE         — CareerJet locale_code (default en_GB)
//   CAREERJET_AFFID          — legacy affiliate id (legacy path only)
//   CAREERJET_AFFILIATE_URL  — legacy Referer/url (legacy path only)

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Content-Type": "application/json",
};

const CAREERJET_LEGACY_URL = "http://public.api.careerjet.net/search";
const CAREERJET_V4_URL     = "https://search.api.careerjet.net/v4/query";
const JSEARCH_URL = "https://jsearch.p.rapidapi.com/search";

const COUNTRY_CODES = {
  israel: "il",
  "united states": "us",
  usa: "us",
  us: "us",
  "united kingdom": "gb",
  uk: "gb",
  england: "gb",
  germany: "de",
  france: "fr",
  canada: "ca",
  netherlands: "nl",
  spain: "es",
  italy: "it",
  india: "in",
  australia: "au",
};

// Major Israeli cities — a bare city name (no "Israel") should still route to
// CareerJet, the dedicated IL provider. JSearch has poor Israel coverage.
const ISRAEL_CITIES = [
  "tel aviv", "tel-aviv", "telaviv", "jerusalem", "haifa", "beer sheva",
  "beersheba", "netanya", "herzliya", "herzeliya", "ramat gan", "rehovot",
  "petah tikva", "petach tikva", "rishon lezion", "rishon le zion", "ashdod",
  "ashkelon", "modiin", "modi'in", "kfar saba", "raanana", "ra'anana", "holon",
  "bat yam", "givatayim", "yokneam", "caesarea", "nazareth", "eilat",
  "tiberias", "nes ziona", "yavne", "hod hasharon", "or yehuda", "airport city",
];

function detectCountry(location) {
  if (!location) return null;
  const lower = location.toLowerCase().trim();
  for (const [name, code] of Object.entries(COUNTRY_CODES)) {
    if (lower.includes(name)) return code;
  }
  if (ISRAEL_CITIES.some((c) => lower.includes(c))) return "il";
  return null;
}

// CareerJet descriptions come back with HTML (<b> around matched terms, entities,
// stray whitespace). Flatten to clean plain text for the cards and the AI.
function cleanText(s) {
  if (!s) return "";
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Shared: turn a CareerJet `jobs` array + hit count into our normalized shape,
// HTML-cleaned and de-duplicated (CareerJet re-lists the same posting on
// different dates).
function normalizeCareerjet(rawJobs, hits) {
  const mapped = (rawJobs || []).map((j) => ({
    title: cleanText(j.title),
    company: cleanText(j.company),
    location: cleanText(j.locations || j.location),
    salary: j.salary ? cleanText(j.salary) : null,
    date: j.date || null,
    description: cleanText(j.description),
    url: j.url,
    isRemote: false,
    type: null,
    source: "careerjet",
  }));

  const seen = new Set();
  const jobs = mapped.filter((j) => {
    const key = `${j.title.toLowerCase()}|${j.company.toLowerCase()}|${j.location.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { jobs, total: hits || 0 };
}

// CareerJet v4 — the current, supported API. Needs a publisher API key
// (CAREERJET_API_KEY), sent as the HTTP Basic Auth username with an empty
// password. Register free at https://www.careerjet.com/partners/register/as-publisher
async function fetchFromCareerjetV4(keywords, location, sourceIp, userAgent, page) {
  const apiKey = process.env.CAREERJET_API_KEY;

  const params = new URLSearchParams({
    keywords: keywords || "software developer",
    location: location || "",
    locale_code: process.env.CAREERJET_LOCALE || "en_GB",
    sort: "relevance",
    page: String(page),
    page_size: "10",
    user_ip: sourceIp || "127.0.0.1",
    user_agent: userAgent || "UPply/1.0",
  });

  const res = await fetch(`${CAREERJET_V4_URL}?${params}`, {
    headers: {
      // Basic <base64(apikey + ":")>
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      Accept: "application/json",
    },
  });
  const rawText = await res.text();
  log("info", "CareerJet v4 response", { status: res.status, snippet: rawText.slice(0, 200) });

  if (!res.ok) return { jobs: [], total: 0, failed: `CareerJet v4 HTTP ${res.status}` };

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return { jobs: [], total: 0, failed: "CareerJet v4 returned non-JSON" };
  }
  if (data.type === "ERROR") return { jobs: [], total: 0, failed: `CareerJet v4: ${data.error}` };

  return normalizeCareerjet(data.jobs, data.hits);
}

// CareerJet legacy public API — being retired. No key, but only accepts requests
// whose Referer is a pre-registered partner domain (our old value
// https://www.int.mta.ac.il no longer works). Kept only as a fallback for when
// no v4 key is configured.
async function fetchFromCareerjetLegacy(keywords, location, sourceIp, userAgent, page) {
  const affiliateUrl = process.env.CAREERJET_AFFILIATE_URL || "https://www.example.com";

  const params = new URLSearchParams({
    affid: process.env.CAREERJET_AFFID || "upply_aws_project",
    keywords: keywords || "software developer",
    location: location || "",
    locale_code: process.env.CAREERJET_LOCALE || "en_GB",
    pagesize: "10",
    page: String(page),
    sort: "relevance",
    user_ip: sourceIp || "127.0.0.1",
    user_agent: userAgent || "UPply/1.0",
    url: affiliateUrl,
  });

  const res = await fetch(`${CAREERJET_LEGACY_URL}?${params}`, {
    headers: { Referer: affiliateUrl, "User-Agent": userAgent || "UPply/1.0" },
  });
  const rawText = await res.text();
  log("info", "CareerJet legacy response", { status: res.status, snippet: rawText.slice(0, 200) });

  if (!res.ok) return { jobs: [], total: 0, failed: `CareerJet HTTP ${res.status}` };

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return { jobs: [], total: 0, failed: "CareerJet returned non-JSON" };
  }
  if (data.type === "ERROR") return { jobs: [], total: 0, failed: `CareerJet: ${data.error}` };

  return normalizeCareerjet(data.jobs, data.hits);
}

// Use v4 when a key is configured, otherwise fall back to the legacy endpoint.
async function fetchFromCareerJet(keywords, location, sourceIp, userAgent, page) {
  return process.env.CAREERJET_API_KEY
    ? fetchFromCareerjetV4(keywords, location, sourceIp, userAgent, page)
    : fetchFromCareerjetLegacy(keywords, location, sourceIp, userAgent, page);
}

async function fetchFromJSearch(keywords, location, country, page) {
  const query = [keywords || "software developer", location].filter(Boolean).join(" in ");
  const params = new URLSearchParams({ query, page: String(page), num_pages: "1" });
  if (country) params.set("country", country);

  const res = await fetch(`${JSEARCH_URL}?${params}`, {
    headers: {
      "x-rapidapi-key": process.env.RAPIDAPI_KEY,
      "x-rapidapi-host": "jsearch.p.rapidapi.com",
    },
  });
  if (!res.ok) throw new Error(`JSearch HTTP ${res.status}`);
  const data = await res.json();

  const jobs = (data.data || []).map((j) => ({
    title: j.job_title,
    company: j.employer_name,
    location: [j.job_city, j.job_state, j.job_country].filter(Boolean).join(", "),
    salary:
      j.job_min_salary && j.job_max_salary
        ? `${j.job_salary_currency || "$"}${j.job_min_salary.toLocaleString()} – ${j.job_max_salary.toLocaleString()}`
        : null,
    date: j.job_posted_at_datetime_utc
      ? new Date(j.job_posted_at_datetime_utc).toLocaleDateString()
      : null,
    description: j.job_description,
    url: j.job_apply_link,
    isRemote: !!j.job_is_remote,
    type: j.job_employment_type || null,
    source: "jsearch",
  }));

  // JSearch returns total_count in the response
  const total = data.total_count || 0;
  return { jobs, total };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS" || event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const qs = event.queryStringParameters || {};
  const keywords = qs.keywords || "";
  const location  = qs.location  || "";
  const country   = qs.country   || detectCountry(location);
  const page      = Math.max(1, parseInt(qs.page || "1", 10));

  log("info", "Jobs search request", { keywords, location, country, page });

  const sourceIp  = event.requestContext?.http?.sourceIp || event.requestContext?.identity?.sourceIp;
  const userAgent = event.headers?.["user-agent"] || event.headers?.["User-Agent"];

  try {
    let source;
    let jobs = [];
    let total = 0;

    if (country === "il") {
      // Israel: try CareerJet first, fall back to JSearch (country=il) if it
      // errors or comes back empty — CareerJet's legacy API is unreliable.
      source = "careerjet";
      const cj = await fetchFromCareerJet(keywords, location, sourceIp, userAgent, page);
      jobs = cj.jobs;
      total = cj.total;

      if (cj.failed || jobs.length === 0) {
        log("warn", "CareerJet unavailable — falling back to JSearch", { reason: cj.failed || "no results" });
        try {
          const js = await fetchFromJSearch(keywords, location, "il", page);
          source = "jsearch";
          jobs = js.jobs;
          total = js.total;
        } catch (fallbackErr) {
          // Both providers failed — return an empty result set (200), not a 500,
          // so the UI shows "no jobs" and the AI agent can just broaden its search.
          log("error", "Both job providers failed for Israel search", { error: fallbackErr.message });
          source = "none";
          jobs = [];
          total = 0;
        }
      }
    } else {
      source = "jsearch";
      const js = await fetchFromJSearch(keywords, location, country, page);
      jobs = js.jobs;
      total = js.total;
    }

    log("info", "Jobs search complete", { source, count: jobs.length, total, page });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        jobs,
        source,
        count: jobs.length,
        page,
        total,
        // Dedup can drop a page below 10, so trust the provider's total when we
        // have it: there is more if this page didn't reach the end of `total`.
        has_more: total > 0 ? page * 10 < total : jobs.length === 10,
      }),
    };
  } catch (err) {
    log("error", "Jobs search failed", { keywords, location, error: err.message });
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message, jobs: [] }),
    };
  }
};
