// UPply — /jobs Lambda
// Routes searches to JSearch (US/UK/global) or CareerJet (Israel).
// Supports pagination: pass ?page=N (1-based, 10 results per page).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Content-Type": "application/json",
};

const CAREERJET_URL = "http://public.api.careerjet.net/search";
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

function detectCountry(location) {
  if (!location) return null;
  const lower = location.toLowerCase().trim();
  for (const [name, code] of Object.entries(COUNTRY_CODES)) {
    if (lower.includes(name)) return code;
  }
  return null;
}

async function fetchFromCareerJet(keywords, location, sourceIp, userAgent, page) {
  const affiliateUrl = process.env.CAREERJET_AFFILIATE_URL || "https://www.int.mta.ac.il";

  const params = new URLSearchParams({
    affid: process.env.CAREERJET_AFFID || "upply_aws_project",
    keywords: keywords || "software developer",
    location: location || "",
    locale_code: "en_GB",
    pagesize: "10",
    page: String(page),
    sort: "relevance",
    user_ip: sourceIp || "127.0.0.1",
    user_agent: userAgent || "UPply/1.0",
    url: affiliateUrl,
  });

  const res = await fetch(`${CAREERJET_URL}?${params}`, {
    headers: {
      "Referer": affiliateUrl,
      "User-Agent": userAgent || "UPply/1.0",
    },
  });
  const rawText = await res.text();
  console.log("CareerJet status:", res.status);
  console.log("CareerJet raw response (first 500 chars):", rawText.slice(0, 500));

  if (!res.ok) throw new Error(`CareerJet HTTP ${res.status}: ${rawText.slice(0, 200)}`);

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`CareerJet returned non-JSON. Likely affid not approved yet. First 200 chars: ${rawText.slice(0, 200)}`);
  }
  if (data.type === "ERROR") throw new Error(`CareerJet: ${data.error}`);

  const jobs = (data.jobs || []).map((j) => ({
    title: j.title,
    company: j.company,
    location: j.locations,
    salary: j.salary || null,
    date: j.date || null,
    description: j.description,
    url: j.url,
    isRemote: false,
    type: null,
    source: "careerjet",
  }));

  // CareerJet returns `hits` = total results found
  const total = data.hits || 0;
  return { jobs, total };
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

  const sourceIp  = event.requestContext?.http?.sourceIp || event.requestContext?.identity?.sourceIp;
  const userAgent = event.headers?.["user-agent"] || event.headers?.["User-Agent"];

  try {
    const useCareerJet = country === "il";

    const { jobs, total } = useCareerJet
      ? await fetchFromCareerJet(keywords, location, sourceIp, userAgent, page)
      : await fetchFromJSearch(keywords, location, country, page);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        jobs,
        source: useCareerJet ? "careerjet" : "jsearch",
        count: jobs.length,
        page,
        total,
        has_more: jobs.length === 10,   // if we got a full page, assume there's more
      }),
    };
  } catch (err) {
    console.error("Jobs lambda error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message, jobs: [] }),
    };
  }
};
