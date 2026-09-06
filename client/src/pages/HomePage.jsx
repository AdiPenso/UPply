import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import logo from "../assets/Logo.png";
import { fetchJobs, getProfile, getActivity, postActivity, analyzeJobFit, tailorResume } from "../services/api";
import { downloadResumePdf } from "../utils/resumePdf";
import { clearUserSessionData } from "../utils/authCleanup";
import AIChatPanel from "../components/AIChatPanel.jsx";

// ── Job-results cache ─────────────────────────────────────────────────────────
// We keep the last search result in sessionStorage so navigating to AccountPage
// and back instantly restores the list without a network round-trip.
// Cache expires after 5 minutes to avoid showing very stale jobs.
const JOBS_CACHE_KEY = "upply_jobs_cache";
const JOBS_CACHE_TTL = 5 * 60 * 1000; // 5 min

// The home feed's opening search. Location defaults to Israel so the first
// results come from CareerJet (fast, local) instead of a slow, US-centric
// JSearch query; once the profile loads, initPage re-runs this once with the
// user's own target role and location.
const DEFAULT_KW = "software engineer";
const DEFAULT_LOC = "Israel";

function readJobsCache() {
  try {
    const raw = sessionStorage.getItem(JOBS_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (Date.now() - c.ts > JOBS_CACHE_TTL) return null;
    return c; // { kw, loc, page, jobs, hasMore }
  } catch { return null; }
}

// CareerJet's search API only returns a short snippet (often ending in "…").
// Heuristic so the details modal can say "preview only".
function isPreviewDescription(desc) {
  if (!desc) return false;
  const t = desc.trim();
  return t.length < 500 || /(?:\.\.\.|…)\s*$/.test(t);
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
  // Read the warm job cache ONCE, synchronously, before the first paint. When the
  // user navigates Account → Home this lets the feed render instantly instead of
  // showing skeletons while unrelated profile/activity calls finish.
  const [warmCache] = useState(readJobsCache);

  const [jobs, setJobs] = useState(() => warmCache?.jobs ?? []);
  const [keywords, setKeywords] = useState("");
  const [location, setLocation] = useState("");
  const [isLoading, setIsLoading] = useState(() => !warmCache);
  const [error, setError] = useState("");
  const [userName, setUserName] = useState("");
  const [fullName, setFullName] = useState("");
  const [isReturning, setIsReturning] = useState(true);
  const [savedJobs, setSavedJobs] = useState(new Set());
  const [userId, setUserId] = useState("");

  // Pagination
  const [page, setPage] = useState(() => warmCache?.page ?? 1);
  const [hasMore, setHasMore] = useState(() => warmCache?.hasMore ?? false);
  const [searchedKw, setSearchedKw] = useState(() => warmCache?.kw ?? DEFAULT_KW);
  const [searchedLoc, setSearchedLoc] = useState(() => warmCache?.loc ?? DEFAULT_LOC);

  // Apply confirmation modal ("did you submit?")
  const [applyModal, setApplyModal] = useState(null); // job object or null

  // Pre-apply "Tailor my resume" flow.
  // null | { job, stage: 'options'|'loading'|'preview'|'noCV', resume, error, copied }
  const [tailorModal, setTailorModal] = useState(null);

  // Full job-details modal (no redirect — everything here is already in `job`)
  const [viewModal, setViewModal] = useState(null); // job object or null

  // AI job-fit analysis modal: null | { job, result, loading }
  const [analyzeModal, setAnalyzeModal] = useState(null);

  const navigate = useNavigate();

  // Flips true the moment the user runs their own search or pages the feed, so
  // the one-time "personalise the opening feed from the profile" step in
  // initPage doesn't yank the results out from under them.
  const userSearchedRef = useRef(false);

  // Run once on mount.
  useEffect(() => {
    initPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initPage = async () => {
    // Fetch jobs straight away only when the cache was cold — the warm-cache case
    // is already on screen from the initial state above. This is not gated behind
    // auth / profile / activity, so the feed never waits on them.
    if (!warmCache) {
      searchJobs(searchedKw, searchedLoc, page);
    }

    // Profile, name and saved-job state load in the background and only update
    // the header + Save buttons — they never touch `isLoading`.
    try {
      const session = await fetchAuthSession();
      const uid = session?.tokens?.idToken?.payload?.sub;
      if (!uid) return;
      setUserId(uid);

      // First-visit detection via localStorage keyed by user id
      const visitKey = `upply_visited_${uid}`;
      setIsReturning(!!localStorage.getItem(visitKey));
      localStorage.setItem(visitKey, "1");

      // Name — localStorage is the only fast path; Cognito JWT is never used
      // because it caches the old name until the next sign-in.
      const cacheKey = `upply_name_${uid}`;
      const nameCached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (nameCached?.first) setUserName(nameCached.first);
      if (nameCached?.first || nameCached?.last) {
        setFullName([nameCached.first, nameCached.last].filter(Boolean).join(" "));
      }

      const [profile, activity] = await Promise.all([
        getProfile(uid).catch(() => null),
        getActivity(uid).catch(() => null),
      ]);

      if (profile?.first_name) {
        setUserName(profile.first_name);
        setFullName([profile.first_name, profile.last_name].filter(Boolean).join(" "));
        localStorage.setItem(
          cacheKey,
          JSON.stringify({ first: profile.first_name, last: profile.last_name || "" })
        );
      }
      if (Array.isArray(activity?.saved)) {
        setSavedJobs(new Set(activity.saved.map((j) => j.job_url)));
      }

      // Refine the opening feed to the user's own target role + location — once,
      // and only if they haven't already searched or paged the feed themselves.
      if (!warmCache && !userSearchedRef.current && profile) {
        const kw = String(profile.desired_role || profile.title || DEFAULT_KW).trim();
        const loc = String(profile.location || DEFAULT_LOC).trim();
        if (kw !== searchedKw || loc !== searchedLoc) {
          setSearchedKw(kw);
          setSearchedLoc(loc);
          setPage(1);
          searchJobs(kw, loc, 1);
        }
      }
    } catch (err) {
      console.warn("Could not load profile:", err);
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
      setError("We couldn't load jobs right now — try again in a moment, or adjust your search.");
      setJobs([]);
      setHasMore(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = () => {
    userSearchedRef.current = true;
    const kw = keywords || DEFAULT_KW;
    setSearchedKw(kw);
    setSearchedLoc(location);
    setPage(1);
    searchJobs(kw, location, 1);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleSearch();
  };

  const handlePrevPage = () => {
    userSearchedRef.current = true;
    const p = Math.max(1, page - 1);
    setPage(p);
    searchJobs(searchedKw, searchedLoc, p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleNextPage = () => {
    userSearchedRef.current = true;
    const p = page + 1;
    setPage(p);
    searchJobs(searchedKw, searchedLoc, p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Re-pull saved jobs — used after the AI agent changes activity from the chat.
  const refreshSavedJobs = async () => {
    if (!userId) return;
    try {
      const activity = await getActivity(userId);
      if (Array.isArray(activity?.saved)) {
        setSavedJobs(new Set(activity.saved.map((j) => j.job_url)));
      }
    } catch (err) {
      console.warn("Could not refresh saved jobs:", err);
    }
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

  // Apply flow: first offer to tailor the resume, then continue to the posting.
  const handleApply = (job) => {
    setTailorModal({ job, stage: "options", resume: "", error: "", copied: false });
  };

  // Runs the AI tailoring against the user's primary CV.
  const runTailorResume = async () => {
    const job = tailorModal.job;
    setTailorModal((m) => ({ ...m, stage: "loading", error: "" }));
    try {
      const { has_cv, resume } = await tailorResume(userId, job);
      if (!has_cv) {
        setTailorModal((m) => ({ ...m, stage: "noCV" }));
        return;
      }
      setTailorModal((m) => ({ ...m, stage: "preview", resume: resume || "" }));
    } catch (err) {
      setTailorModal((m) => ({ ...m, stage: "options", error: err.message || "Couldn't tailor the resume." }));
    }
  };

  const copyTailored = async () => {
    try {
      await navigator.clipboard.writeText(tailorModal.resume);
      setTailorModal((m) => ({ ...m, copied: true }));
      setTimeout(() => setTailorModal((m) => (m ? { ...m, copied: false } : m)), 2000);
    } catch { /* clipboard blocked — user can select the text */ }
  };

  const downloadTailoredPdf = async () => {
    const job = tailorModal.job;
    try {
      await downloadResumePdf(tailorModal.resume, fullName || userName, job.company || job.title);
    } catch {
      setTailorModal((m) => (m ? { ...m, error: "Couldn't build the PDF — use Copy or the .txt download." } : m));
    }
  };

  const downloadTailoredTxt = () => {
    const job = tailorModal.job;
    const safe = (job.company || job.title || "resume")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const blob = new Blob([tailorModal.resume], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `resume-${safe || "job"}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Leave the tailor modal → open the external posting → show the "did you submit?" prompt.
  const proceedToApply = () => {
    const job = tailorModal.job;
    setTailorModal(null);
    window.open(job.url, "_blank", "noopener,noreferrer");
    setApplyModal(job);
  };

  // Called when user answers Yes/No in the "did you submit?" modal
  const confirmApply = async (didApply) => {
    if (didApply && applyModal) {
      await trackActivity("apply", applyModal);
    }
    setApplyModal(null);
  };

  const handleLogout = async () => {
    clearUserSessionData();
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
                onView={() => setViewModal(job)}
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

      {/* ── Tailor-my-resume flow (shown when Apply is clicked) ── */}
      {tailorModal && (
        <div
          style={modalStyles.overlay}
          onClick={(e) => {
            // Backdrop click closes only on the options screen (no work to lose)
            if (e.target === e.currentTarget && tailorModal.stage === "options") setTailorModal(null);
          }}
        >
          <div style={viewStyles.box}>
            <div style={viewStyles.header}>
              <div style={{ minWidth: 0 }}>
                <div style={viewStyles.headerTitle}>
                  {tailorModal.stage === "preview" ? "Your tailored resume" : "Before you apply"}
                </div>
                <div style={viewStyles.headerCompany}>
                  {tailorModal.job.title}
                  {tailorModal.job.company ? ` · ${tailorModal.job.company}` : ""}
                </div>
              </div>
              <button style={analyzeStyles.closeBtn} onClick={() => setTailorModal(null)}>✕</button>
            </div>

            {/* Options */}
            {tailorModal.stage === "options" && (
              <>
                <div style={{ ...viewStyles.body, gap: "14px" }}>
                  <p style={tailorStyles.lead}>
                    Want the AI to reorder and rephrase your resume to match this role
                    before you head to the application? It only re-emphasises what's
                    already in your CV — it never adds anything.
                  </p>
                  {tailorModal.error && <p style={tailorStyles.error}>⚠️ {tailorModal.error}</p>}
                </div>
                <div style={viewStyles.actions}>
                  <button
                    style={{ ...cardStyles.saveBtn, flex: 1 }}
                    onClick={proceedToApply}
                  >
                    Skip →
                  </button>
                  <button
                    style={{ ...cardStyles.applyBtn, flex: 1.4 }}
                    onClick={runTailorResume}
                  >
                    ✨ Tailor my resume
                  </button>
                </div>
              </>
            )}

            {/* Loading */}
            {tailorModal.stage === "loading" && (
              <div style={{ ...viewStyles.body, alignItems: "center", justifyContent: "center", padding: "48px 20px" }}>
                <div style={tailorStyles.spinner} />
                <p style={tailorStyles.loadingText}>
                  Tailoring your resume to this role…
                  <br />
                  <span style={{ fontSize: "12px", opacity: 0.7 }}>Matching your experience to the job requirements</span>
                </p>
              </div>
            )}

            {/* No CV on file */}
            {tailorModal.stage === "noCV" && (
              <>
                <div style={{ ...viewStyles.body, gap: "12px" }}>
                  <p style={tailorStyles.lead}>
                    📄 You don't have a resume on file yet. Upload one on your Account
                    page and UPply can tailor it to any job (and auto-fill your profile).
                  </p>
                </div>
                <div style={viewStyles.actions}>
                  <button style={{ ...cardStyles.saveBtn, flex: 1 }} onClick={proceedToApply}>
                    Continue without it →
                  </button>
                  <button
                    style={{ ...cardStyles.applyBtn, flex: 1.2 }}
                    onClick={() => navigate("/account")}
                  >
                    Upload a resume
                  </button>
                </div>
              </>
            )}

            {/* Preview */}
            {tailorModal.stage === "preview" && (
              <>
                <div style={viewStyles.body}>
                  <div style={tailorStyles.note}>
                    ✅ Reordered and rephrased from your existing resume — nothing invented.
                    Review it, then download the PDF to attach to your application.
                  </div>
                  <pre style={tailorStyles.resumeBox}>{tailorModal.resume}</pre>
                  <button style={tailorStyles.textLink} onClick={downloadTailoredTxt}>
                    or download as plain .txt
                  </button>
                  {tailorModal.error && <p style={tailorStyles.error}>⚠️ {tailorModal.error}</p>}
                </div>
                <div style={viewStyles.actions}>
                  <button style={{ ...cardStyles.saveBtn, flex: 1 }} onClick={copyTailored}>
                    {tailorModal.copied ? "✓ Copied" : "📋 Copy"}
                  </button>
                  <button style={{ ...cardStyles.analyzeBtn, flex: 1 }} onClick={downloadTailoredPdf}>
                    ⬇ Download PDF
                  </button>
                  <button style={{ ...cardStyles.applyBtn, flex: 1.2 }} onClick={proceedToApply}>
                    Continue to application →
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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

      {/* ── Job Details Modal (no redirect — just what we already fetched) ── */}
      {viewModal && (
        <div
          style={modalStyles.overlay}
          onClick={(e) => { if (e.target === e.currentTarget) setViewModal(null); }}
        >
          <div style={viewStyles.box}>
            <div style={viewStyles.header}>
              <div style={{ minWidth: 0 }}>
                <div style={viewStyles.headerTitle}>{viewModal.title}</div>
                <div style={viewStyles.headerCompany}>{viewModal.company || "Unknown company"}</div>
              </div>
              <button style={analyzeStyles.closeBtn} onClick={() => setViewModal(null)}>✕</button>
            </div>

            <div style={viewStyles.body}>
              <div style={viewStyles.factsGrid}>
                {viewModal.location && (
                  <div style={viewStyles.fact}>
                    <span style={viewStyles.factIcon}>📍</span>
                    <div>
                      <div style={viewStyles.factLabel}>Location</div>
                      <div style={viewStyles.factValue}>
                        {viewModal.location}{viewModal.isRemote ? " · Remote" : ""}
                      </div>
                    </div>
                  </div>
                )}
                {viewModal.type && (
                  <div style={viewStyles.fact}>
                    <span style={viewStyles.factIcon}>🕐</span>
                    <div>
                      <div style={viewStyles.factLabel}>Job type</div>
                      <div style={viewStyles.factValue}>{viewModal.type}</div>
                    </div>
                  </div>
                )}
                {viewModal.salary && (
                  <div style={viewStyles.fact}>
                    <span style={viewStyles.factIcon}>💰</span>
                    <div>
                      <div style={viewStyles.factLabel}>Salary</div>
                      <div style={viewStyles.factValue}>{viewModal.salary}</div>
                    </div>
                  </div>
                )}
                {viewModal.date && (
                  <div style={viewStyles.fact}>
                    <span style={viewStyles.factIcon}>📅</span>
                    <div>
                      <div style={viewStyles.factLabel}>Posted</div>
                      <div style={viewStyles.factValue}>{viewModal.date}</div>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div style={viewStyles.sectionLabel}>Description</div>
                <div style={viewStyles.descriptionBox}>
                  {viewModal.description || "No description provided for this posting."}
                </div>
                {isPreviewDescription(viewModal.description) && (
                  <div style={viewStyles.previewHint}>
                    ℹ️ This source gives a short preview only — open the full posting with
                    <b> Apply</b> to read everything.
                  </div>
                )}
              </div>
            </div>

            <div style={viewStyles.actions}>
              <button
                style={{ ...(savedJobs.has(viewModal.url) ? cardStyles.savedBtn : cardStyles.saveBtn), flex: 1 }}
                onClick={() => handleSave(viewModal)}
              >
                {savedJobs.has(viewModal.url) ? "✓ Saved" : "🔖 Save"}
              </button>
              <button
                style={{ ...cardStyles.analyzeBtn, flex: 1 }}
                onClick={() => { setViewModal(null); handleAnalyze(viewModal); }}
              >
                📊 Analyze
              </button>
              <button
                style={{ ...cardStyles.applyBtn, flex: 1 }}
                onClick={() => { setViewModal(null); handleApply(viewModal); }}
              >
                Apply →
              </button>
            </div>
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

      {/* ── AI Career Agent floating panel ── */}
      <AIChatPanel userId={userId} onDataChanged={refreshSavedJobs} />
    </div>
  );
}

// ── Job Card ──────────────────────────────────────────────────────────────────

function JobCard({ job, isSaved, onSave, onApply, onAnalyze, onView }) {
  // Any click on the card opens the details panel; the action buttons stop the
  // click from bubbling up so they still do their own thing.
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };

  return (
    <div style={cardStyles.card} onClick={onView} title="Click for full details">
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
        <button style={cardStyles.analyzeBtn} onClick={stop(onAnalyze)} title="AI job-fit analysis">
          📊 Analyze
        </button>
        <button
          style={isSaved ? cardStyles.savedBtn : cardStyles.saveBtn}
          onClick={stop(onSave)}
        >
          {isSaved ? "✓ Saved" : "Save"}
        </button>
        <button style={cardStyles.applyBtn} onClick={stop(onApply)}>
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
    cursor: "pointer",
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
    borderWidth: "5px",
    borderStyle: "solid",
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

// ── Job details modal styles ─────────────────────────────────────────────────
const viewStyles = {
  // The box itself never scrolls — only `body` does — so the header and the
  // Save/Analyze/Apply footer always stay in view, even for a long posting.
  box: {
    background: "#ffffff",
    borderRadius: "20px",
    width: "min(600px, 94vw)",
    maxHeight: "86vh",
    boxShadow: "0 24px 60px rgba(0,0,0,0.22)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    padding: "20px",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "12px",
    flexShrink: 0,
  },
  headerTitle: { fontSize: "17px", fontWeight: "800", color: "#fff", lineHeight: 1.3 },
  headerCompany: { fontSize: "13px", fontWeight: "600", color: "rgba(255,255,255,0.85)", marginTop: "4px" },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
  // 2-column grid of icon + label/value "facts" — scans faster than a row of chips.
  factsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: "16px 20px",
  },
  fact: { display: "flex", alignItems: "flex-start", gap: "8px" },
  factIcon: { fontSize: "15px", lineHeight: "20px", flexShrink: 0 },
  factLabel: {
    fontSize: "10.5px",
    fontWeight: "700",
    color: "#9ca3af",
    textTransform: "uppercase",
    letterSpacing: "0.4px",
  },
  factValue: { fontSize: "13.5px", fontWeight: "600", color: "#1f2937", marginTop: "1px" },
  sectionLabel: {
    fontSize: "11px",
    fontWeight: "700",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginBottom: "8px",
  },
  descriptionBox: {
    fontSize: "13.5px",
    lineHeight: 1.7,
    color: "#374151",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    background: "#f9fafb",
    border: "1px solid #f3f4f6",
    borderRadius: "12px",
    padding: "14px 16px",
  },
  previewHint: {
    marginTop: "8px",
    fontSize: "12px",
    color: "#6b7280",
    lineHeight: 1.5,
  },
  actions: {
    display: "flex",
    gap: "10px",
    padding: "16px 20px",
    borderTop: "1px solid #f3f4f6",
    flexShrink: 0,
  },
};

// ── Tailor-my-resume modal styles ────────────────────────────────────────────
const tailorStyles = {
  lead: {
    margin: 0,
    fontSize: "14px",
    lineHeight: 1.6,
    color: "#374151",
  },
  error: {
    margin: 0,
    fontSize: "13px",
    color: "#991b1b",
    background: "#fee2e2",
    border: "1px solid #fecaca",
    borderRadius: "10px",
    padding: "8px 12px",
  },
  note: {
    fontSize: "12.5px",
    lineHeight: 1.5,
    color: "#065f46",
    background: "#f0fdf4",
    border: "1px solid #dcfce7",
    borderRadius: "10px",
    padding: "9px 12px",
  },
  resumeBox: {
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "12.5px",
    lineHeight: 1.65,
    color: "#1f2937",
    background: "#f9fafb",
    border: "1px solid #f3f4f6",
    borderRadius: "12px",
    padding: "14px 16px",
  },
  textLink: {
    alignSelf: "flex-start",
    background: "none",
    border: "none",
    padding: 0,
    fontSize: "12px",
    color: "#7c3aed",
    textDecoration: "underline",
    cursor: "pointer",
  },
  spinner: {
    width: "40px",
    height: "40px",
    borderWidth: "4px",
    borderStyle: "solid",
    borderColor: "#e5e7eb #e5e7eb #e5e7eb #7c3aed",
    borderRadius: "50%",
    animation: "spin 0.9s linear infinite",
    marginBottom: "16px",
  },
  loadingText: {
    margin: 0,
    textAlign: "center",
    fontSize: "14px",
    color: "#6b7280",
    lineHeight: 1.6,
  },
};
