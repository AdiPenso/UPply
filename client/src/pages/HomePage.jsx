import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import logo from "../assets/Logo.png";
import { fetchJobs, getProfile, getActivity, postActivity, analyzeJobFit } from "../services/api";
import AIChatPanel from "../components/AIChatPanel.jsx";

// ── Job-results cache ─────────────────────────────────────────────────────────
// We keep the last search result in sessionStorage so navigating to AccountPage
// and back instantly restores the list without a network round-trip.
// Cache expires after 5 minutes to avoid showing very stale jobs.
const JOBS_CACHE_KEY = "upply_jobs_cache";
const JOBS_CACHE_TTL = 5 * 60 * 1000; // 5 min

function readJobsCache() {
  try {
    const raw = sessionStorage.getItem(JOBS_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (Date.now() - c.ts > JOBS_CACHE_TTL) return null;
    return c; // { kw, loc, page, jobs, hasMore }
  } catch { return null; }
}

function writeJobsCache(kw, loc, pg, jobs, hasMore) {
  try {
    sessionStorage.setItem(
      JOBS_CACHE_KEY,
      JSON.stringify({ kw, loc, page: pg, jobs, hasMore, ts: Date.now() })
    );
  } catch { /* storage quota exceeded — safe to ignore */ }
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

  // Pagination
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [searchedKw, setSearchedKw] = useState("software developer");
  const [searchedLoc, setSearchedLoc] = useState("");

  // Apply confirmation modal
  const [applyModal, setApplyModal] = useState(null); // job object or null

  // AI job-fit analysis modal: null | { job, result, loading }
  const [analyzeModal, setAnalyzeModal] = useState(null);

  const navigate = useNavigate();

  useEffect(() => {
    initPage();
  }, []);

  const initPage = async () => {
    try {
      const session = await fetchAuthSession();
      const payload = session?.tokens?.idToken?.payload || {};
      const uid = payload.sub;
      if (uid) setUserId(uid);

      // First-visit detection via localStorage keyed by user id
      const visitKey = uid ? `upply_visited_${uid}` : null;
      const hasVisited = visitKey ? localStorage.getItem(visitKey) : null;
      setIsReturning(!!hasVisited);
      if (visitKey) localStorage.setItem(visitKey, "1");

      // Name — localStorage is the only fast path; Cognito JWT is never used
      // because it caches the old name until the next sign-in.
      if (uid) {
        const cacheKey = `upply_name_${uid}`;
        const nameCached = JSON.parse(localStorage.getItem(cacheKey) || "null");
        // Show the cached name instantly (no flicker) while DynamoDB loads.
        if (nameCached?.first) setUserName(nameCached.first);

        const [profile, activity] = await Promise.all([
          getProfile(uid).catch(() => null),
          getActivity(uid).catch(() => null),
        ]);

        if (profile?.first_name) {
          setUserName(profile.first_name);
          localStorage.setItem(
            cacheKey,
            JSON.stringify({ first: profile.first_name, last: profile.last_name || "" })
          );
        }
        if (Array.isArray(activity?.saved)) {
          setSavedJobs(new Set(activity.saved.map((j) => j.job_url)));
        }
      }
    } catch (err) {
      console.warn("Could not load profile:", err);
    }

    // ── Restore job cache if still warm ──────────────────────────────────────
    // If the user navigated away and back within 5 minutes, skip the network
    // call and show the cached results immediately.
    const jobsCache = readJobsCache();
    if (jobsCache) {
      setSearchedKw(jobsCache.kw);
      setSearchedLoc(jobsCache.loc);
      setPage(jobsCache.page);
      setJobs(jobsCache.jobs);
      setHasMore(jobsCache.hasMore);
      setIsLoading(false);
    } else {
      searchJobs("software developer", "", 1);
    }
  };

  const searchJobs = async (kw, loc, pg = 1) => {
    setIsLoading(true);
    setError("");
    try {
      const { jobs: results, hasMore: more } = await fetchJobs(kw, loc, pg);
      setJobs(results);
      setHasMore(more);
      // Keep the cache warm so back-navigation is instant.
      writeJobsCache(kw, loc, pg, results, more);
    } catch (err) {
      console.error("Job fetch error:", err);
      setError(err.message || "Could not load jobs.");
      setJobs([]);
      setHasMore(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = () => {
    const kw = keywords || "software developer";
    setSearchedKw(kw);
    setSearchedLoc(location);
    setPage(1);
    searchJobs(kw, location, 1);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleSearch();
  };

  const handlePrevPage = () => {
    const p = Math.max(1, page - 1);
    setPage(p);
    searchJobs(searchedKw, searchedLoc, p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleNextPage = () => {
    const p = page + 1;
    setPage(p);
    searchJobs(searchedKw, searchedLoc, p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const trackActivity = async (action, job) => {
    if (!userId) return;
    try {
      await postActivity(userId, action, job);
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

  // Open the URL immediately, then ask if they actually submitted
  const handleApply = (job) => {
    window.open(job.url, "_blank", "noopener,noreferrer");
    setApplyModal(job);
  };

  // Called when user answers Yes/No in the modal
  const confirmApply = async (didApply) => {
    if (didApply && applyModal) {
      await trackActivity("apply", applyModal);
    }
    setApplyModal(null);
  };

  const handleLogout = async () => {
    await signOut();
    navigate("/login");
  };

  const handleAnalyze = async (job) => {
    if (!userId) return;
    // Open modal in loading state immediately
    setAnalyzeModal({ job, result: null, loading: true });
    try {
      const result = await analyzeJobFit(userId, job);
      setAnalyzeModal({ job, result, loading: false });
    } catch (err) {
      setAnalyzeModal({ job, result: null, loading: false, error: err.message });
    }
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
          {isLoading
            ? "🔍 Searching for the best jobs for you, please wait…"
            : jobs.length > 0
            ? `Page ${page}`
            : ""}
        </p>

        {/* Error */}
        {error && <p style={styles.errorText}>{error}</p>}

        {/* Job feed */}
        <div style={styles.feed}>
          {/* Skeleton while loading */}
          {isLoading && [...Array(5)].map((_, i) => <SkeletonCard key={i} />)}

          {/* Empty state */}
          {!isLoading && !error && jobs.length === 0 && (
            <p style={styles.emptyText}>
              No jobs found. Try different keywords or location.
            </p>
          )}

          {/* Job cards */}
          {!isLoading &&
            jobs.map((job, idx) => (
              <JobCard
                key={idx}
                job={job}
                isSaved={savedJobs.has(job.url)}
                onSave={() => handleSave(job)}
                onApply={() => handleApply(job)}
                onAnalyze={() => handleAnalyze(job)}
              />
            ))}
        </div>

        {/* Pagination */}
        {!isLoading && !error && (page > 1 || hasMore) && (
          <div style={styles.pagination}>
            <button
              style={{
                ...styles.pageBtn,
                opacity: page === 1 ? 0.4 : 1,
                cursor: page === 1 ? "not-allowed" : "pointer",
              }}
              onClick={handlePrevPage}
              disabled={page === 1}
            >
              ← Previous
            </button>
            <span style={styles.pageNum}>Page {page}</span>
            <button
              style={{
                ...styles.pageBtn,
                opacity: !hasMore ? 0.4 : 1,
                cursor: !hasMore ? "not-allowed" : "pointer",
              }}
              onClick={handleNextPage}
              disabled={!hasMore}
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {/* Apply confirmation modal — cannot be dismissed without answering */}
      {applyModal && (
        <div style={modalStyles.overlay}>
          <div style={modalStyles.box}>
            <div style={modalStyles.icon}>📤</div>
            <h3 style={modalStyles.title}>Did you submit your application?</h3>
            <p style={modalStyles.sub}>
              <strong>{applyModal.title}</strong>
              {applyModal.company ? ` at ${applyModal.company}` : ""}
            </p>
            <div style={modalStyles.buttons}>
              <button
                style={modalStyles.yesBtn}
                onClick={() => confirmApply(true)}
              >
                ✅ Yes, I applied
              </button>
              <button
                style={modalStyles.noBtn}
                onClick={() => confirmApply(false)}
              >
                ✗ Not yet
              </button>
            </div>
            <p style={modalStyles.note}>
              Please answer to continue — this keeps your stats accurate.
            </p>
          </div>
        </div>
      )}

      {/* ── AI Job-Fit Analysis Modal ── */}
      {analyzeModal && (
        <div style={modalStyles.overlay}>
          <div style={analyzeStyles.box}>
            {/* Header */}
            <div style={analyzeStyles.header}>
              <div>
                <div style={analyzeStyles.headerLabel}>🤖 AI Analysis</div>
                <div style={analyzeStyles.headerJob}>
                  {analyzeModal.job.title}
                  {analyzeModal.job.company ? ` · ${analyzeModal.job.company}` : ""}
                </div>
              </div>
              <button style={analyzeStyles.closeBtn} onClick={() => setAnalyzeModal(null)}>✕</button>
            </div>

            {/* Loading */}
            {analyzeModal.loading && (
              <div style={analyzeStyles.loadingWrap}>
                <div style={analyzeStyles.loadingSpinner} />
                <p style={analyzeStyles.loadingText}>Analyzing your fit…<br /><span style={{ fontSize: "12px", opacity: 0.7 }}>Comparing your profile to the job requirements</span></p>
              </div>
            )}

            {/* Error */}
            {!analyzeModal.loading && analyzeModal.error && (
              <div style={analyzeStyles.errorWrap}>
                <p style={{ color: "#991b1b", fontSize: "14px" }}>⚠️ {analyzeModal.error}</p>
                <button style={analyzeStyles.retryBtn} onClick={() => handleAnalyze(analyzeModal.job)}>Try again</button>
              </div>
            )}

            {/* Result */}
            {!analyzeModal.loading && analyzeModal.result && (() => {
              const r = analyzeModal.result;
              const score = r.fit_score ?? 0;
              const color = score >= 80 ? "#10b981" : score >= 60 ? "#3b82f6" : score >= 40 ? "#f59e0b" : "#ef4444";
              return (
                <div style={analyzeStyles.result}>
                  {/* Score */}
                  <div style={analyzeStyles.scoreRow}>
                    <div style={{ ...analyzeStyles.scoreCircle, borderColor: color }}>
                      <span style={{ ...analyzeStyles.scoreNum, color }}>{score}</span>
                      <span style={analyzeStyles.scoreLabel}>/ 100</span>
                    </div>
                    <div>
                      <div style={{ ...analyzeStyles.verdict, color }}>{r.verdict}</div>
                      <div style={analyzeStyles.keyReqs}>
                        {(r.key_requirements || []).map(req => (
                          <span key={req} style={analyzeStyles.reqChip}>{req}</span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div style={analyzeStyles.sections}>
                    {/* Strengths */}
                    {r.strengths?.length > 0 && (
                      <div style={analyzeStyles.section}>
                        <div style={{ ...analyzeStyles.sectionTitle, color: "#065f46" }}>✅ Your strengths</div>
                        {r.strengths.map((s, i) => <div key={i} style={{ ...analyzeStyles.item, background: "#f0fdf4", color: "#065f46" }}>• {s}</div>)}
                      </div>
                    )}
                    {/* Gaps */}
                    {r.gaps?.length > 0 && (
                      <div style={analyzeStyles.section}>
                        <div style={{ ...analyzeStyles.sectionTitle, color: "#92400e" }}>⚠️ Gaps to address</div>
                        {r.gaps.map((g, i) => <div key={i} style={{ ...analyzeStyles.item, background: "#fffbeb", color: "#78350f" }}>• {g}</div>)}
                      </div>
                    )}
                    {/* Recommendations */}
                    {r.recommendations?.length > 0 && (
                      <div style={analyzeStyles.section}>
                        <div style={{ ...analyzeStyles.sectionTitle, color: "#1e40af" }}>💡 Recommended actions</div>
                        {r.recommendations.map((rec, i) => <div key={i} style={{ ...analyzeStyles.item, background: "#eff6ff", color: "#1e40af" }}>• {rec}</div>)}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div style={analyzeStyles.actions}>
                    <button
                      style={{ ...analyzeStyles.actionBtn, background: savedJobs.has(analyzeModal.job.url) ? "#e5e7eb" : "linear-gradient(135deg,#7c3aed,#06b6d4)", color: savedJobs.has(analyzeModal.job.url) ? "#6b7280" : "#fff" }}
                      onClick={() => { handleSave(analyzeModal.job); }}
                    >
                      {savedJobs.has(analyzeModal.job.url) ? "✓ Saved" : "🔖 Save Job"}
                    </button>
                    <button
                      style={{ ...analyzeStyles.actionBtn, background: "#1f2937", color: "#fff" }}
                      onClick={() => { handleApply(analyzeModal.job); setAnalyzeModal(null); }}
                    >
                      Apply →
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── AI Career Coach floating panel ── */}
      <AIChatPanel userId={userId} />
    </div>
  );
}

// ── Job Card ──────────────────────────────────────────────────────────────────

function JobCard({ job, isSaved, onSave, onApply, onAnalyze }) {
  return (
    <div style={cardStyles.card}>
      <div style={cardStyles.body}>
        <h3 style={cardStyles.title}>{job.title}</h3>
        <p style={cardStyles.company}>{job.company}</p>
        <div style={cardStyles.meta}>
          {job.location && (
            <span style={cardStyles.metaItem}>📍 {job.location}</span>
          )}
          {job.isRemote && (
            <span style={cardStyles.remoteBadge}>Remote</span>
          )}
          {job.type && (
            <span style={cardStyles.metaItem}>🕐 {job.type}</span>
          )}
          {job.salary && (
            <span style={cardStyles.salary}>💰 {job.salary}</span>
          )}
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
        <button style={cardStyles.analyzeBtn} onClick={onAnalyze} title="AI job-fit analysis">
          📊 Analyze
        </button>
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

// ── Skeleton Card (shown while loading) ──────────────────────────────────────

function SkeletonCard() {
  return (
    <div style={cardStyles.card}>
      <div style={{ flex: 1 }}>
        <span className="skeleton-shimmer" style={sk.title} />
        <span className="skeleton-shimmer" style={sk.company} />
        <div style={sk.metaRow}>
          <span className="skeleton-shimmer" style={sk.chip} />
          <span className="skeleton-shimmer" style={sk.chip} />
        </div>
        <span className="skeleton-shimmer" style={sk.line} />
        <span className="skeleton-shimmer" style={{ ...sk.line, width: "65%" }} />
      </div>
      <div style={cardStyles.actions}>
        <span className="skeleton-shimmer" style={sk.btn} />
        <span className="skeleton-shimmer" style={sk.btn} />
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
  logo: { width: "90px" },
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
    minHeight: "20px",
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
  pagination: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "16px",
    padding: "28px 0 8px",
  },
  pageBtn: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "10px",
    padding: "10px 22px",
    fontSize: "14px",
    fontWeight: "700",
    boxShadow: "0 4px 12px rgba(124,58,237,0.3)",
  },
  pageNum: {
    fontSize: "14px",
    color: "#6b7280",
    fontWeight: "600",
    minWidth: "64px",
    textAlign: "center",
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
  body: { flex: 1, minWidth: 0 },
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
  metaItem: { fontSize: "13px", color: "#6b7280" },
  remoteBadge: {
    fontSize: "12px",
    fontWeight: "600",
    color: "#1d4ed8",
    background: "#dbeafe",
    borderRadius: "6px",
    padding: "2px 8px",
  },
  salary: { fontSize: "13px", color: "#065f46", fontWeight: "500" },
  date: { fontSize: "13px", color: "#9ca3af" },
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
  analyzeBtn: {
    background: "#f3f4f6",
    color: "#374151",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "9px 14px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
};

// Skeleton placeholder dimensions
const sk = {
  title:   { height: "18px", width: "55%", marginBottom: "10px" },
  company: { height: "14px", width: "35%", marginBottom: "12px" },
  metaRow: { display: "flex", gap: "10px", marginBottom: "12px" },
  chip:    { height: "12px", width: "80px" },
  line:    { height: "12px", width: "90%", marginBottom: "6px" },
  btn:     { height: "36px", width: "80px", borderRadius: "10px" },
};

// Apply confirmation modal styles
const modalStyles = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    backdropFilter: "blur(4px)",
  },
  box: {
    background: "#ffffff",
    borderRadius: "20px",
    padding: "36px 32px",
    maxWidth: "400px",
    width: "90%",
    textAlign: "center",
    boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
  },
  icon:  { fontSize: "40px", marginBottom: "12px" },
  title: {
    fontSize: "20px",
    fontWeight: "800",
    color: "#111827",
    margin: "0 0 8px 0",
  },
  sub: {
    fontSize: "14px",
    color: "#6b7280",
    margin: "0 0 24px 0",
    lineHeight: 1.5,
  },
  buttons: {
    display: "flex",
    gap: "12px",
    justifyContent: "center",
    marginBottom: "14px",
  },
  yesBtn: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "12px",
    padding: "12px 24px",
    fontSize: "15px",
    fontWeight: "700",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(124,58,237,0.3)",
  },
  noBtn: {
    background: "#f3f4f6",
    color: "#374151",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    padding: "12px 24px",
    fontSize: "15px",
    fontWeight: "600",
    cursor: "pointer",
  },
  note: {
    fontSize: "11px",
    color: "#9ca3af",
    margin: 0,
  },
};

// ── Analysis modal styles ─────────────────────────────────────────────────────
const analyzeStyles = {
  box: {
    background: "#ffffff",
    borderRadius: "20px",
    width: "min(560px, 94vw)",
    maxHeight: "88vh",
    overflowY: "auto",
    boxShadow: "0 24px 60px rgba(0,0,0,0.22)",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    padding: "18px 20px",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    borderRadius: "20px 20px 0 0",
    flexShrink: 0,
  },
  headerLabel: { fontSize: "11px", fontWeight: "700", color: "rgba(255,255,255,0.8)", letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: "4px" },
  headerJob:   { fontSize: "15px", fontWeight: "700", color: "#fff" },
  closeBtn: {
    background: "rgba(255,255,255,0.15)",
    border: "none",
    borderRadius: "8px",
    color: "#fff",
    fontSize: "14px",
    cursor: "pointer",
    padding: "5px 9px",
    flexShrink: 0,
    marginLeft: "12px",
  },
  loadingWrap: {
    padding: "48px 24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
  },
  loadingSpinner: {
    width: "42px",
    height: "42px",
    border: "4px solid #e5e7eb",
    borderTop: "4px solid #7c3aed",
    borderRadius: "50%",
    animation: "spin 0.9s linear infinite",
  },
  loadingText: { margin: 0, textAlign: "center", fontSize: "14px", color: "#6b7280", lineHeight: 1.6 },
  errorWrap: { padding: "32px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" },
  retryBtn: {
    background: "linear-gradient(135deg,#7c3aed,#06b6d4)",
    color: "#fff",
    border: "none",
    borderRadius: "10px",
    padding: "8px 20px",
    fontSize: "13px",
    fontWeight: "700",
    cursor: "pointer",
  },
  result: { padding: "20px", display: "flex", flexDirection: "column", gap: "16px" },
  scoreRow: { display: "flex", alignItems: "center", gap: "20px" },
  scoreCircle: {
    width: "88px",
    height: "88px",
    borderRadius: "50%",
    border: "5px solid",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  scoreNum:   { fontSize: "28px", fontWeight: "800", lineHeight: 1 },
  scoreLabel: { fontSize: "11px", color: "#9ca3af", fontWeight: "600" },
  verdict:    { fontSize: "18px", fontWeight: "800", marginBottom: "8px" },
  keyReqs:    { display: "flex", flexWrap: "wrap", gap: "6px" },
  reqChip: {
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    borderRadius: "999px",
    padding: "3px 10px",
    fontSize: "11px",
    fontWeight: "600",
    color: "#374151",
  },
  sections: { display: "flex", flexDirection: "column", gap: "12px" },
  section:  { display: "flex", flexDirection: "column", gap: "6px" },
  sectionTitle: { fontSize: "12px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.4px" },
  item: {
    fontSize: "13px",
    padding: "8px 12px",
    borderRadius: "10px",
    lineHeight: 1.5,
  },
  actions: { display: "flex", gap: "10px", paddingTop: "4px" },
  actionBtn: {
    flex: 1,
    padding: "11px",
    borderRadius: "12px",
    border: "none",
    fontSize: "14px",
    fontWeight: "700",
    cursor: "pointer",
  },
};
