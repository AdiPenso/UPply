// UPply — API Service
// All communication with the AWS API Gateway lives here.
// Pages import functions from this file instead of writing raw fetch() calls.

import { API_BASE_URL } from "../aws/config";

// ── Profile ───────────────────────────────────────────────────────────────────

// Check if a user profile exists. Returns { exists, ...profileFields }
export const getProfile = async (userId) => {
  const res = await fetch(`${API_BASE_URL}/profile?user_id=${userId}`);
  if (!res.ok) throw new Error(`getProfile failed: ${res.status}`);
  return res.json();
};

// Create a new profile after first login (registration flow).
export const createProfile = async (data) => {
  const res = await fetch(`${API_BASE_URL}/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`createProfile failed: ${res.status}`);
  return res.json();
};

// Update specific profile fields (AccountPage). Only sends the fields provided.
export const updateProfile = async (userId, fields) => {
  const res = await fetch(`${API_BASE_URL}/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, ...fields }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`);
  }
  return res.json();
};

// ── Jobs ──────────────────────────────────────────────────────────────────────

// Search jobs. Lambda routes to CareerJet (Israel) or JSearch (everywhere else).
// Returns { jobs: [...], hasMore: bool } — fetches one page of 10 at a time.
export const fetchJobs = async (keywords, location, page = 1) => {
  const params = new URLSearchParams();
  if (keywords) params.set("keywords", keywords);
  if (location)  params.set("location", location);
  params.set("page", String(page));

  const res = await fetch(`${API_BASE_URL}/jobs?${params}`);
  if (!res.ok) {
    const text = await res.text();
    console.error("Jobs API error:", res.status, text);
    throw new Error(`Jobs API error ${res.status}`);
  }
  const data = await res.json();
  return {
    jobs: data.jobs || [],
    hasMore: data.has_more ?? (data.jobs?.length === 10),
  };
};

// ── Activity ──────────────────────────────────────────────────────────────────

// Get all saved and applied jobs for a user.
export const getActivity = async (userId) => {
  const res = await fetch(`${API_BASE_URL}/activity?user_id=${userId}`);
  if (!res.ok) throw new Error(`getActivity failed: ${res.status}`);
  return res.json();
};

// Track a user action: "save", "unsave", or "apply".
export const postActivity = async (userId, action, job) => {
  const res = await fetch(`${API_BASE_URL}/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      action,
      job: {
        job_url: job.url,
        title: job.title,
        company: job.company,
        location: job.location,
      },
    }),
  });
  if (!res.ok) throw new Error(`postActivity failed: ${res.status}`);
  return res.json();
};

// Update the status of an existing apply row (interview / offer / accepted / rejected).
// activityId is the DynamoDB sort key returned by getActivity (e.g. "apply#...").
export const updateActivityStatus = async (userId, activityId, status) => {
  const res = await fetch(`${API_BASE_URL}/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, action: "update_status", activity_id: activityId, status }),
  });
  if (!res.ok) throw new Error(`updateActivityStatus failed: ${res.status}`);
  return res.json();
};

// Hard-delete an activity row (works for both saved and applied items).
export const deleteActivity = async (userId, activityId) => {
  const res = await fetch(`${API_BASE_URL}/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, action: "delete", activity_id: activityId }),
  });
  if (!res.ok) throw new Error(`deleteActivity failed: ${res.status}`);
  return res.json();
};

// ── Documents (CV files) ──────────────────────────────────────────────────────

// Get a presigned S3 PUT URL so the browser can upload directly to S3.
// Returns { upload_url, s3_key }
export const getUploadUrl = async (userId, fileName) => {
  const res = await fetch(`${API_BASE_URL}/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, file_name: fileName }),
  });
  if (!res.ok) throw new Error(`getUploadUrl failed: ${res.status}`);
  return res.json();
};

// Upload the actual PDF bytes directly to S3 using the presigned URL.
// Must use PUT with Content-Type: application/pdf — no auth headers.
export const uploadFileToS3 = async (presignedUrl, file) => {
  const res = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`);
};

// List all CVs for a user. Returns { documents: [...] }
export const getDocuments = async (userId) => {
  const res = await fetch(`${API_BASE_URL}/documents?action=list&user_id=${userId}`);
  if (!res.ok) throw new Error(`getDocuments failed: ${res.status}`);
  return res.json();
};

// Save CV metadata to DynamoDB after a successful S3 upload.
export const saveDocument = async (userId, { docId, s3Key, fileName, cvText, isPrimary }) => {
  const res = await fetch(`${API_BASE_URL}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id:    userId,
      action:     "save",
      doc_id:     docId,
      s3_key:     s3Key,
      file_name:  fileName,
      cv_text:    cvText,
      is_primary: isPrimary,
    }),
  });
  if (!res.ok) throw new Error(`saveDocument failed: ${res.status}`);
  return res.json();
};

// Mark one CV as the primary (used by AI for chat/analysis). Unmarks all others.
export const setPrimaryDocument = async (userId, docId) => {
  const res = await fetch(`${API_BASE_URL}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, action: "set_primary", doc_id: docId }),
  });
  if (!res.ok) throw new Error(`setPrimaryDocument failed: ${res.status}`);
  return res.json();
};

// Delete a CV from both DynamoDB and S3.
export const deleteDocument = async (userId, docId) => {
  const res = await fetch(`${API_BASE_URL}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, action: "delete", doc_id: docId }),
  });
  if (!res.ok) throw new Error(`deleteDocument failed: ${res.status}`);
  return res.json();
};

// Get a temporary (5-min) presigned download URL for one CV.
export const getDownloadUrl = async (userId, docId) => {
  const res = await fetch(
    `${API_BASE_URL}/documents?action=download_url&user_id=${userId}&doc_id=${encodeURIComponent(docId)}`
  );
  if (!res.ok) throw new Error(`getDownloadUrl failed: ${res.status}`);
  return res.json();
};

// ── AI Career Coach ───────────────────────────────────────────────────────────

// Send a chat message to the AI career coach.
// history = array of { role: "user"|"assistant", content: string }
// Returns { reply: string }
export const askAI = async (userId, message, history = []) => {
  const res = await fetch(`${API_BASE_URL}/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, mode: "chat", message, history }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AI service error ${res.status}: ${txt.slice(0, 120)}`);
  }
  return res.json();
};

// Parse a CV/resume and extract structured profile data.
// cvText = plain text extracted from the PDF client-side.
// Returns { first_name, last_name, title, years_experience, skills, bio, location, ... }
export const extractCV = async (userId, cvText) => {
  const res = await fetch(`${API_BASE_URL}/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, mode: "extract_cv", cv_text: cvText }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`CV extraction error ${res.status}: ${txt.slice(0, 120)}`);
  }
  return res.json();
};

// Analyze how well the user fits a specific job posting.
// job = { title, company, location, description, url }
// Returns { fit_score, verdict, strengths, gaps, recommendations, key_requirements }
export const analyzeJobFit = async (userId, job) => {
  const res = await fetch(`${API_BASE_URL}/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, mode: "analyze_job", job }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Analysis error ${res.status}: ${txt.slice(0, 120)}`);
  }
  return res.json();
};
