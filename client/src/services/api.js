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
// Returns a normalized array of job objects.
export const fetchJobs = async (keywords, location) => {
  const params = new URLSearchParams();
  if (keywords) params.set("keywords", keywords);
  if (location) params.set("location", location);

  const res = await fetch(`${API_BASE_URL}/jobs?${params}`);
  if (!res.ok) {
    const text = await res.text();
    console.error("Jobs API error:", res.status, text);
    throw new Error(`Jobs API error ${res.status}`);
  }
  const data = await res.json();
  return data.jobs || [];
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
