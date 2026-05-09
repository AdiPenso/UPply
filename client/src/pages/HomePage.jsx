import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import logo from "../assets/Logo.png";
import { API_BASE_URL } from "../aws/config";

// Calls our AWS Lambda via API Gateway.
// The Lambda decides whether to query JSearch (global) or CareerJet (Israel)
// and returns a normalized job list.
async function fetchJobs(keywords, location) {
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
  console.log("Jobs response:", data);
  return data.jobs || [];
}

export default function HomePage() {
  const [jobs, setJobs] = useState([]);
  const [keywords, setKeywords] = useState("");
  const [location, setLocation] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [userName, setUserName] = useState("");
  const [isReturning, setIsReturning] = useState(true);
  const [savedJobs, setSavedJobs] = useState(new Set());
  const [userId, setUserId] = useState("");

  const navigate = useNavigate();

  useEffect(() => {
    initPage();
  }, []);

  const initPage = async () => {
    // Load profile name in background — don't block the page from rendering
    try {
      const session = await fetchAuthSession();
      const payload = session?.tokens?.idToken?.payload || {};
      const userId = payload.sub;
      if (userId) setUserId(userId);

      // First-visit detection via localStorage keyed by user id
      const visitKey = userId ? `upply_visited_${userId}` : null;
      const hasVisited = visitKey ? localStorage.getItem(visitKey) : null;
      setIsReturning(!!hasVisited);
      if (visitKey) localStorage.setItem(visitKey, "1");

      // Fallback from Cognito token while DynamoDB fetch is in flight
      let tokenName = payload.given_name || (payload.name ? payload.name.split(" ")[0] : "");
      if (!tokenName && payload.email) {
        const raw = payload.email.split("@")[0].split(/[._\d]/)[0];
        tokenName = raw.charAt(0).toUpperCase() + raw.slice(1);
      }
      if (tokenName) setUserName(tokenName);

      // DynamoDB is the source of truth — prefer first_name from /profile.
      // Activity (saved jobs) comes from the dedicated UserActivity table via /activity.
      if (userId) {
        const [profileRes, activityRes] = await Promise.all([
          fetch(`${API_BASE_URL}/profile?user_id=${userId}`),
          fetch(`${API_BASE_URL}/activity?user_id=${userId}`),
        ]);
        if (profileRes.ok) {
          const profile = await profileRes.json();
          if (profile.first_name) setUserName(profile.first_name);
        }
        if (activityRes.ok) {
          const activity = await activityRes.json();
          if (Array.isArray(activity.saved)) {
            setSavedJobs(new Set(activity.saved.map((j) => j.job_url)));
          }
        }
      }
    } catch (err) {
      console.warn("Could not load profile:", err);
    }

    searchJobs("software developer", "");
  };

  const searchJobs = async (kw, loc) => {
    setIsLoading(true);
    setError("");
    try {
      const results = await fetchJobs(kw, loc);
      setJobs(results);
    } catch (err) {
      console.error("Job fetch error:", err);
      setError(err.message || "Could not load jobs.");
      setJobs([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = () => {
    searchJobs(keywords || "software developer", location);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleSearch();
  };

  const trackActivity = async (action, job) => {
    if (!userId) return;
    try {
      await fetch(`${API_BASE_URL}/activity`, {
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
    } catch (err) {
      console.warn("Activity tracking failed:", err);
    }
  };

  const handleSave = (job) => {
    const isSaved = savedJobs.has(job.url);
    // Optimistic UI update
    setSavedJobs((prev) => {
      const next = new Set(prev);
      if (isSaved) next.delete(job.url);
      else next.add(job.url);
      return next;
    });
    trackActivity(isSaved ? "unsave" : "save", job);
  };

  const handleApply = (job) => {
    trackActivity("apply", job);
    window.open(job.url, "_blank", "noopener,noreferrer");
  };

  const handleLogout = async () => {
    await signOut();
    navigate("/login");
  };

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <img src={logo} alt="UPply" style={styles.logo} />
        <div style={styles.headerRight}>
          <div
            style={styles.userPill}
            onClick={() => navigate("/account")}
            title="Go to My Account"
          >
            <div style={styles.avatar}>
              <span style={styles.avatarLetter}>
                {(userName || "U").charAt(0).toUpperCase()}
              </span>
              <div style={styles.avatarDot} />
            </div>
            <div style={styles.userText}>
              <span style={styles.greetingSmall}>
                ✨ {isReturning ? "Welcome back" : "Welcome"}
              </span>
              <span style={styles.userName}>{userName || "there"}</span>
            </div>
            <span style={styles.chevron}>›</span>
          </div>
          <button style={styles.logoutBtn} onClick={handleLogout}>
            Logout ↗
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={styles.content}>
        {/* Search bar */}
        <div style={styles.searchRow}>
          <input
            style={styles.searchInput}
            type="text"
            placeholder="Job title, skills, keywords..."
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <input
            style={styles.locationInput}
            type="text"
            placeholder="Location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button style={styles.searchBtn} onClick={handleSearch}>
            Search
          </button>
        </div>

        {/* Feed label */}
        <p style={styles.feedLabel}>
          {isLoading ? "Loading..." : jobs.length > 0 ? `${jobs.length} jobs found` : ""}
        </p>

        {/* Error */}
        {error && <p style={styles.errorText}>{error}</p>}

        {/* Job feed */}
        <div style={styles.feed}>
          {!isLoading && !error && jobs.length === 0 && (
            <p style={styles.emptyText}>No jobs found. Try different keywords or location.</p>
          )}

          {jobs.map((job, idx) => (
            <JobCard
              key={idx}
              job={job}
              isSaved={savedJobs.has(job.url)}
              onSave={() => handleSave(job)}
              onApply={() => handleApply(job)}
            />
          ))}

        </div>
      </div>
    </div>
  );
}

function JobCard({ job, isSaved, onSave, onApply }) {
  return (
    <div style={cardStyles.card}>
      <div style={cardStyles.body}>
        <h3 style={cardStyles.title}>{job.title}</h3>
        <p style={cardStyles.company}>{job.company}</p>
        <div style={cardStyles.meta}>
          {job.location && <span style={cardStyles.metaItem}>📍 {job.location}</span>}
          {job.isRemote && <span style={cardStyles.remoteBadge}>Remote</span>}
          {job.type && <span style={cardStyles.metaItem}>🕐 {job.type}</span>}
          {job.salary && <span style={cardStyles.salary}>💰 {job.salary}</span>}
          {job.date && <span style={cardStyles.date}>{job.date}</span>}
        </div>
        {job.description && (
          <p style={cardStyles.description}>
            {job.description.length > 160
              ? job.description.slice(0, 160) + "..."
              : job.description}
          </p>
        )}
      </div>
      <div style={cardStyles.actions}>
        <button
          style={isSaved ? cardStyles.savedBtn : cardStyles.saveBtn}
          onClick={onSave}
        >
          {isSaved ? "✓ Saved" : "Save"}
        </button>
        <button style={cardStyles.applyBtn} onClick={onApply}>
          Apply →
        </button>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f3f4f6",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    background: "#ffffff",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    padding: "16px 32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  logo: {
    width: "90px",
  },
  headerRight: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "4px",
  },
  userPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 10px 4px 4px",
    background: "#ffffff",
    border: "1.5px solid transparent",
    borderRadius: "999px",
    cursor: "pointer",
    backgroundImage:
      "linear-gradient(#ffffff, #ffffff), linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    backgroundOrigin: "border-box",
    backgroundClip: "padding-box, border-box",
    boxShadow: "0 3px 10px rgba(124,58,237,0.15)",
  },
  avatar: {
    position: "relative",
    width: "30px",
    height: "30px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 3px 10px rgba(124,58,237,0.35)",
    flexShrink: 0,
  },
  avatarLetter: {
    color: "white",
    fontWeight: "800",
    fontSize: "14px",
    letterSpacing: "0.3px",
    textShadow: "0 1px 2px rgba(0,0,0,0.15)",
  },
  avatarDot: {
    position: "absolute",
    bottom: "0px",
    right: "0px",
    width: "9px",
    height: "9px",
    borderRadius: "50%",
    background: "#10b981",
    border: "1.5px solid white",
  },
  userText: {
    display: "flex",
    flexDirection: "column",
    lineHeight: 1.1,
    overflow: "hidden",
  },
  greetingSmall: {
    fontSize: "9px",
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: "0.6px",
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
  },
  userName: {
    fontSize: "13px",
    color: "#1f2937",
    fontWeight: "800",
    marginTop: "2px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  chevron: {
    fontSize: "18px",
    fontWeight: "700",
    lineHeight: 1,
    marginLeft: "2px",
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
  },
  logoutBtn: {
    alignSelf: "flex-end",
    background: "transparent",
    border: "none",
    padding: "0 4px",
    fontSize: "10px",
    fontWeight: "500",
    color: "#9ca3af",
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  btnIcon: {
    fontSize: "12px",
  },
  content: {
    maxWidth: "760px",
    width: "100%",
    margin: "0 auto",
    padding: "32px 24px",
    flex: 1,
  },
  searchRow: {
    display: "flex",
    gap: "12px",
    marginBottom: "8px",
  },
  searchInput: {
    flex: 2,
    padding: "14px 16px",
    fontSize: "16px",
    borderRadius: "12px",
    border: "1px solid #d1d5db",
    outline: "none",
    background: "#ffffff",
  },
  locationInput: {
    flex: 1,
    padding: "14px 16px",
    fontSize: "16px",
    borderRadius: "12px",
    border: "1px solid #d1d5db",
    outline: "none",
    background: "#ffffff",
  },
  searchBtn: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "12px",
    padding: "14px 28px",
    fontSize: "16px",
    fontWeight: "700",
    letterSpacing: "0.3px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxShadow: "0 6px 16px rgba(124,58,237,0.35)",
  },
  feedLabel: {
    fontSize: "14px",
    color: "#6b7280",
    margin: "8px 0 16px 0",
  },
  errorText: {
    color: "#b91c1c",
    background: "#fee2e2",
    border: "1px solid #fecaca",
    borderRadius: "12px",
    padding: "12px 16px",
    fontSize: "14px",
    marginBottom: "16px",
  },
  feed: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  emptyText: {
    textAlign: "center",
    color: "#9ca3af",
    fontSize: "15px",
    marginTop: "48px",
  },
};

const cardStyles = {
  card: {
    background: "#ffffff",
    borderRadius: "16px",
    padding: "20px 24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "16px",
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    margin: "0 0 4px 0",
    fontSize: "17px",
    fontWeight: "700",
    color: "#111827",
  },
  company: {
    margin: "0 0 8px 0",
    fontSize: "14px",
    color: "#2f68e3",
    fontWeight: "600",
  },
  meta: {
    display: "flex",
    flexWrap: "wrap",
    gap: "12px",
    marginBottom: "8px",
  },
  metaItem: {
    fontSize: "13px",
    color: "#6b7280",
  },
  remoteBadge: {
    fontSize: "12px",
    fontWeight: "600",
    color: "#1d4ed8",
    background: "#dbeafe",
    borderRadius: "6px",
    padding: "2px 8px",
  },
  salary: {
    fontSize: "13px",
    color: "#065f46",
    fontWeight: "500",
  },
  date: {
    fontSize: "13px",
    color: "#9ca3af",
  },
  description: {
    margin: 0,
    fontSize: "13px",
    color: "#6b7280",
    lineHeight: "1.5",
  },
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    flexShrink: 0,
  },
  saveBtn: {
    background: "#f3f4f6",
    color: "#374151",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "9px 18px",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  savedBtn: {
    background: "#d1fae5",
    color: "#065f46",
    border: "1px solid #a7f3d0",
    borderRadius: "10px",
    padding: "9px 18px",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  applyBtn: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "10px",
    padding: "9px 18px",
    fontSize: "14px",
    fontWeight: "700",
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxShadow: "0 4px 12px rgba(124,58,237,0.3)",
  },
};
