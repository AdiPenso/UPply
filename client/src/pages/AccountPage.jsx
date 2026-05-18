import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import logo from "../assets/Logo.png";
import {
  getProfile, getActivity, updateProfile, updateActivityStatus, deleteActivity,
  extractCV, getUploadUrl, uploadFileToS3, getDocuments,
  saveDocument, setPrimaryDocument, deleteDocument, getDownloadUrl,
} from "../services/api";
import { extractPDFText } from "../utils/extractPDFText";

// ── Activity status options ───────────────────────────────────────────────────
const STATUS_OPTIONS = [
  { value: "applied",   label: "📤 Just Applied" },
  { value: "interview", label: "🎤 In Interview" },
  { value: "offer",     label: "📋 Offer Received" },
  { value: "accepted",  label: "✅ Accepted" },
  { value: "rejected",  label: "❌ Rejected" },
];

// Background / text / border per status — used to tint the select element
const STATUS_STYLE = {
  applied:   { background: "#fef3c7", color: "#92400e", borderColor: "#fde68a" },
  interview: { background: "#dbeafe", color: "#1e40af", borderColor: "#93c5fd" },
  offer:     { background: "#d1fae5", color: "#065f46", borderColor: "#6ee7b7" },
  accepted:  { background: "#f0fdf4", color: "#166534", borderColor: "#86efac" },
  rejected:  { background: "#fee2e2", color: "#991b1b", borderColor: "#fca5a5" },
};

// Fields we count toward "Profile strength"
const STRENGTH_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "location",
  "title",
  "years_experience",
  "desired_role",
  "desired_salary_min",
  "work_mode",
  "skills",
  "bio",
];

function computeStrength(profile) {
  if (!profile) return 0;
  let filled = 0;
  for (const key of STRENGTH_FIELDS) {
    const val = profile[key];
    if (Array.isArray(val)) {
      if (val.length > 0) filled++;
    } else if (val !== undefined && val !== null && String(val).trim() !== "") {
      filled++;
    }
  }
  return Math.round((filled / STRENGTH_FIELDS.length) * 100);
}

export default function AccountPage() {
  const navigate = useNavigate();
  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState(null);
  // cachedName is read from localStorage instantly so the hero never shows a
  // wrong/derived name while the DynamoDB fetch is in-flight.
  const [cachedName, setCachedName] = useState({ first: "", last: "" });
  const [activity, setActivity] = useState({ saved: [], applied: [] });
  const [activeTab, setActiveTab] = useState("profile");
  // Filter inside the Activity History tab
  const [activityFilter, setActivityFilter] = useState("all");
  const [statusNotice, setStatusNotice] = useState("");
  // Custom confirm modal — replaces window.confirm for delete / reject actions
  // Shape: { message, confirmLabel, onConfirm } | null
  const [confirmModal, setConfirmModal] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [saveNotice, setSaveNotice] = useState("");

  // Local editable state for sections
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    phone: "",
    location: "",
    title: "",
    years_experience: "",
    desired_role: "",
    desired_salary_min: "",
    desired_salary_max: "",
    work_mode: "",
    bio: "",
  });
  const [skills, setSkills] = useState([]);
  const [skillInput, setSkillInput] = useState("");

  // CV upload / AI extraction state
  // status: 'idle' | 'reading' | 'extracting' | 'done' | 'error'
  const [cvState, setCvState] = useState({ status: "idle", data: null, fileName: null, error: null });
  const cvFileRef = useRef(null);

  // Uploaded CV files (from UserDocuments table)
  const [documents, setDocuments] = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    setIsLoading(true);
    setErrorMsg("");
    try {
      const session = await fetchAuthSession();
      const payload = session?.tokens?.idToken?.payload || {};
      const sub = payload.sub;
      const userEmail = payload.email || "";
      setUserId(sub || "");
      setEmail(userEmail);

      if (!sub) {
        setErrorMsg("Not signed in.");
        setIsLoading(false);
        return;
      }

      // Read the locally-cached name immediately so the hero shows the right
      // name while the DynamoDB fetch is in-flight — no flicker, no wrong name.
      const cacheKey = `upply_name_${sub}`;
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached) setCachedName(cached);

      // Profile, activity, and documents are all independent — fetch in parallel
      const [raw, act] = await Promise.all([
        getProfile(sub).catch(() => null),
        getActivity(sub).catch(() => null),
      ]);

      // Load CV documents separately (non-critical — don't block profile render)
      getDocuments(sub)
        .then(({ documents: docs }) => setDocuments(docs || []))
        .catch(() => {});

      if (act) {
        setActivity({
          saved: Array.isArray(act.saved) ? act.saved : [],
          applied: Array.isArray(act.applied) ? act.applied : [],
        });
      }

      if (raw) {
        // Handle different response shapes from profile-get Lambda:
        //   - flat object: { first_name: "Lir", ... }
        //   - DynamoDB GetItem: { Item: { first_name: "Lir", ... } }
        //   - wrapped: { profile: { first_name: "Lir", ... } }
        const data = raw?.Item || raw?.profile || raw || {};
        console.log("Loaded profile from DynamoDB:", data);
        setProfile(data);

        // Write the authoritative name to the cache so every page sees it instantly.
        if (data.first_name || data.last_name) {
          const nameEntry = { first: data.first_name || "", last: data.last_name || "" };
          localStorage.setItem(cacheKey, JSON.stringify(nameEntry));
          setCachedName(nameEntry);
        }

        setForm((f) => ({
          ...f,
          first_name: data.first_name || "",
          last_name: data.last_name || "",
          phone: data.phone || "",
          location: data.location || "",
          title: data.title || "",
          years_experience: data.years_experience || "",
          desired_role: data.desired_role || "",
          desired_salary_min: data.desired_salary_min || "",
          desired_salary_max: data.desired_salary_max || "",
          work_mode: data.work_mode || "",
          bio: data.bio || "",
        }));
        if (Array.isArray(data.skills)) setSkills(data.skills);
      } else {
        setErrorMsg("Could not load profile.");
      }
    } catch (err) {
      console.error(err);
      setErrorMsg("Could not load profile.");
    } finally {
      setIsLoading(false);
    }
  };

  // Strip out empty/undefined values so partial updates don't overwrite
  // existing fields with blanks. Skills (array) is always sent because
  // an empty list is itself a meaningful "I removed all my skills".
  const stripEmpty = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      out[k] = v;
    }
    return out;
  };

  const saveFields = async (fields) => {
    if (!userId) {
      setSaveNotice("⚠️ Not signed in.");
      return;
    }
    const cleaned = stripEmpty(fields);
    if (Object.keys(cleaned).length === 0) {
      setSaveNotice("Nothing to save — all fields are empty.");
      setTimeout(() => setSaveNotice(""), 3000);
      return;
    }

    setSaveNotice("Saving…");
    try {
      const data = await updateProfile(userId, cleaned);
      if (data.profile) {
        setProfile(data.profile);
        // Keep the name cache in sync so HomePage shows the new name instantly.
        const updatedFirst = data.profile.first_name || cleaned.first_name || "";
        const updatedLast  = data.profile.last_name  || cleaned.last_name  || "";
        if (updatedFirst || updatedLast) {
          const nameEntry = { first: updatedFirst, last: updatedLast };
          localStorage.setItem(`upply_name_${userId}`, JSON.stringify(nameEntry));
          setCachedName(nameEntry);
        }
      }
      setSaveNotice("✅ Saved!");
      setTimeout(() => setSaveNotice(""), 2500);
    } catch (err) {
      console.error("Save failed:", err);
      setSaveNotice(`❌ Save failed: ${err.message}`);
      setTimeout(() => setSaveNotice(""), 5000);
    }
  };

  const savePersonal = () => {
    // First/last name are required — block save if either is blank
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setSaveNotice("⚠️ First name and last name are required.");
      setTimeout(() => setSaveNotice(""), 3500);
      return;
    }
    return saveFields({
      first_name: form.first_name,
      last_name: form.last_name,
      phone: form.phone,
      location: form.location,
    });
  };

  const saveProfessional = () =>
    saveFields({
      title: form.title,
      years_experience: form.years_experience
        ? Number(form.years_experience)
        : "",
      bio: form.bio,
    });

  const savePreferences = () =>
    saveFields({
      desired_role: form.desired_role,
      work_mode: form.work_mode,
      desired_salary_min: form.desired_salary_min
        ? Number(form.desired_salary_min)
        : "",
      desired_salary_max: form.desired_salary_max
        ? Number(form.desired_salary_max)
        : "",
    });

  // Skills always sends the array (empty array = user cleared all skills)
  const saveSkills = () => saveFields({ skills: skills.length ? skills : [] });

  const handleAddSkill = () => {
    const s = skillInput.trim();
    if (!s) return;
    if (!skills.includes(s)) setSkills([...skills, s]);
    setSkillInput("");
  };

  const handleRemoveSkill = (s) => {
    setSkills(skills.filter((x) => x !== s));
  };

  // ── Activity status / delete handlers ────────────────────────────────────

  const showStatusNotice = (msg) => {
    setStatusNotice(msg);
    setTimeout(() => setStatusNotice(""), 4000);
  };

  // Opens the custom confirm modal; `onConfirm` is called only if the user clicks the confirm button.
  const openConfirm = (message, confirmLabel, onConfirm) =>
    setConfirmModal({ message, confirmLabel, onConfirm });

  const doDelete = async (item) => {
    const kind = item.kind;
    // Optimistic removal
    setActivity((prev) => ({
      ...prev,
      [kind === "save" ? "saved" : "applied"]: (
        kind === "save" ? prev.saved : prev.applied
      ).filter((a) => a.activity_id !== item.activity_id),
    }));
    try {
      await deleteActivity(userId, item.activity_id);
      showStatusNotice("🗑️ Removed from history.");
    } catch {
      showStatusNotice("❌ Could not delete — please try again.");
    }
  };

  const handleStatusChange = async (item, newStatus) => {
    if (!item.activity_id) return;

    // Rejected → show custom confirm modal, then delete on confirmation
    if (newStatus === "rejected") {
      openConfirm(
        `Mark "${item.title || "this job"}" as rejected and remove it from your history?`,
        "Yes, remove it",
        () => doDelete({ ...item, kind: "apply" })
      );
      return;
    }

    // All other statuses — optimistic update, then API call
    setActivity((prev) => ({
      ...prev,
      applied: prev.applied.map((a) =>
        a.activity_id === item.activity_id ? { ...a, status: newStatus } : a
      ),
    }));

    try {
      await updateActivityStatus(userId, item.activity_id, newStatus);
      if (newStatus === "accepted") {
        showStatusNotice("🎉 Congratulations! Don't forget to update your profile title.");
      }
    } catch {
      // Roll back on failure
      setActivity((prev) => ({
        ...prev,
        applied: prev.applied.map((a) =>
          a.activity_id === item.activity_id ? { ...a, status: item.status } : a
        ),
      }));
      showStatusNotice("❌ Could not save status — please try again.");
    }
  };

  const handleDeleteItem = (item) => {
    if (!item.activity_id) return;
    openConfirm(
      `Remove "${item.title || "this job"}" from your history?`,
      "Remove",
      () => doDelete(item)
    );
  };

  // ── CV upload handlers ────────────────────────────────────────────────────

  const handleCVFile = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setCvState({ status: "error", data: null, fileName: file.name, error: "Only PDF files are supported. Please upload a .pdf resume." });
      return;
    }
    setCvState({ status: "reading", data: null, fileName: file.name, error: null });
    try {
      // Run in parallel: get presigned S3 URL + extract text from PDF locally
      const [{ upload_url, s3_key }, cvText] = await Promise.all([
        getUploadUrl(userId, file.name),
        extractPDFText(file),
      ]);

      // Upload the PDF bytes directly to S3
      await uploadFileToS3(upload_url, file);

      // AI extraction of profile fields
      setCvState((s) => ({ ...s, status: "extracting" }));
      const extracted = await extractCV(userId, cvText);

      // Save metadata to UserDocuments table
      // First CV uploaded becomes primary automatically
      const docId     = `cv#${Date.now()}`;
      const isPrimary = documents.length === 0;
      await saveDocument(userId, { docId, s3Key: s3_key, fileName: file.name, cvText, isPrimary });

      // Refresh the documents list
      const { documents: updated } = await getDocuments(userId);
      setDocuments(updated || []);

      setCvState({ status: "done", data: extracted, fileName: file.name, error: null });
    } catch (err) {
      setCvState({ status: "error", data: null, fileName: file.name, error: err.message || "Upload failed. Please try again." });
    }
  };

  const handleSetPrimary = async (doc) => {
    // Optimistic update
    setDocuments((prev) => prev.map((d) => ({ ...d, is_primary: d.doc_id === doc.doc_id })));
    try {
      await setPrimaryDocument(userId, doc.doc_id);
    } catch {
      // Roll back on failure
      const { documents: updated } = await getDocuments(userId);
      setDocuments(updated || []);
      showStatusNotice("❌ Could not update primary CV.");
    }
  };

  const handleDownload = async (doc) => {
    try {
      const { download_url } = await getDownloadUrl(userId, doc.doc_id);
      window.open(download_url, "_blank");
    } catch {
      showStatusNotice("❌ Could not generate download link. Please try again.");
    }
  };

  const handleDeleteDocument = (doc) => {
    openConfirm(
      `Delete "${doc.file_name}" permanently? This cannot be undone.`,
      "Delete CV",
      async () => {
        // Optimistic removal
        setDocuments((prev) => prev.filter((d) => d.doc_id !== doc.doc_id));
        try {
          await deleteDocument(userId, doc.doc_id);
        } catch {
          const { documents: updated } = await getDocuments(userId);
          setDocuments(updated || []);
          showStatusNotice("❌ Could not delete CV.");
        }
      }
    );
  };

  const handleApplyCV = async () => {
    const d = cvState.data;
    if (!d) return;

    // Merge extracted fields into the form (never blank-out existing values)
    const mergedForm = {
      ...form,
      first_name:        d.first_name        || form.first_name,
      last_name:         d.last_name         || form.last_name,
      title:             d.title             || form.title,
      years_experience:  d.years_experience  != null ? String(d.years_experience) : form.years_experience,
      bio:               d.bio               || form.bio,
      location:          d.location          || form.location,
      desired_role:      d.desired_role      || form.desired_role,
      desired_salary_min: d.desired_salary_min != null ? String(d.desired_salary_min) : form.desired_salary_min,
      desired_salary_max: d.desired_salary_max != null ? String(d.desired_salary_max) : form.desired_salary_max,
    };
    setForm(mergedForm);

    // Merge skills (deduplicated)
    const mergedSkills = Array.isArray(d.skills) && d.skills.length > 0
      ? [...new Set([...skills, ...d.skills])]
      : skills;
    if (Array.isArray(d.skills) && d.skills.length > 0) setSkills(mergedSkills);

    // Persist everything to DynamoDB
    await saveFields({
      first_name:        mergedForm.first_name,
      last_name:         mergedForm.last_name,
      title:             mergedForm.title,
      years_experience:  mergedForm.years_experience ? Number(mergedForm.years_experience) : "",
      bio:               mergedForm.bio,
      location:          mergedForm.location,
      desired_role:      mergedForm.desired_role,
      desired_salary_min: mergedForm.desired_salary_min ? Number(mergedForm.desired_salary_min) : "",
      desired_salary_max: mergedForm.desired_salary_max ? Number(mergedForm.desired_salary_max) : "",
      skills:            mergedSkills,
    });

    setCvState({ status: "idle", data: null, fileName: null, error: null });
  };

  const handleLogout = async () => {
    await signOut();
    navigate("/login");
  };

  // Live profile object (merge form + skills) for strength calc
  const liveProfile = {
    ...profile,
    ...form,
    email,
    skills,
  };
  const strength = computeStrength(liveProfile);

  // Hero: prefer the live DynamoDB value; fall back to the localStorage cache
  // (available instantly, written after every successful DynamoDB load).
  // We never derive a name from the email address — that was the source of the
  // stale "Adi" appearing while "Liron" was already saved in DynamoDB.
  const heroFirst = profile?.first_name || cachedName.first || "";
  const heroLast  = profile?.last_name  || cachedName.last  || "";
  const displayName =
    [heroFirst, heroLast].filter(Boolean).join(" ") || "Your name";

  const initial = (heroFirst || "U").charAt(0).toUpperCase();

  // Counts come from the UserActivity table (queried by /activity GET Lambda).
  // Interview count + response rate will come from the apply rows' `status` field
  // once the user updates them in the Applications page (Phase 2).
  const interviewCount = activity.applied.filter(
    (a) => a.status === "interview" || a.status === "offer"
  ).length;

  // Response rate = % of applications where the company responded
  // (any status other than "applied" counts as a response)
  const respondedCount = activity.applied.filter(
    (a) => a.status && a.status !== "applied"
  ).length;
  const responseRate = activity.applied.length > 0
    ? Math.round((respondedCount / activity.applied.length) * 100)
    : null;

  const stats = {
    applied: activity.applied.length,
    interviews: interviewCount,
    saved: activity.saved.length,
    response_rate: responseRate,
  };

  // Merge recent activity (most recent 5 across saves + applies) for sidebar card
  const recent = [
    ...activity.saved.map((j) => ({ ...j, kind: "save" })),
    ...activity.applied.map((j) => ({ ...j, kind: "apply" })),
  ]
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, 5);

  // Full activity history — last 6 months, newest-first, for the Activity tab
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const allActivity = [
    ...activity.saved.map((j) => ({ ...j, kind: "save" })),
    ...activity.applied.map((j) => ({ ...j, kind: "apply" })),
  ]
    .filter((j) => !j.timestamp || new Date(j.timestamp) >= sixMonthsAgo)
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));

  // Counts per filter bucket (used for the filter-tab badges)
  const filterCounts = {
    all:       allActivity.length,
    saved:     allActivity.filter((a) => a.kind === "save").length,
    applied:   allActivity.filter((a) => a.kind === "apply" && (!a.status || a.status === "applied")).length,
    interview: allActivity.filter((a) => a.status === "interview").length,
    offer:     allActivity.filter((a) => a.status === "offer").length,
  };

  // The subset shown in the activity list, based on the selected filter tab
  const filteredActivity = allActivity.filter((a) => {
    if (activityFilter === "all")       return true;
    if (activityFilter === "saved")     return a.kind === "save";
    if (activityFilter === "applied")   return a.kind === "apply" && (!a.status || a.status === "applied");
    if (activityFilter === "interview") return a.status === "interview";
    if (activityFilter === "offer")     return a.status === "offer";
    return true;
  });

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft} onClick={() => navigate("/home")}>
          <img src={logo} alt="UPply" style={styles.logo} />
          <span style={styles.backLink}>← Back to jobs</span>
        </div>
        <button style={styles.logoutBtn} onClick={handleLogout}>
          Logout ↗
        </button>
      </div>

      {/* Hero */}
      <div style={styles.heroWrap}>
        <div style={styles.heroGlow} />
        <div style={styles.hero}>
          <div style={styles.heroAvatar}>
            <span style={styles.heroAvatarLetter}>{initial}</span>
            <div style={styles.heroAvatarDot} />
          </div>
          <div style={styles.heroText}>
            <span style={styles.heroEyebrow}>✨ My Account</span>
            <h1 style={styles.heroName}>{displayName}</h1>
            <p style={styles.heroSub}>
              {profile?.title || "Add your role"} ·{" "}
              {profile?.location || "Add your location"}
            </p>
            {profile?.phone && (
              <p style={styles.heroPhone}>📞 {profile.phone}</p>
            )}
          </div>
          <div style={styles.heroStrength}>
            <div style={styles.strengthRow}>
              <span style={styles.strengthLabel}>Profile strength</span>
              <span style={styles.strengthValue}>{strength}%</span>
            </div>
            <div style={styles.progressBar}>
              <div
                style={{ ...styles.progressFill, width: `${strength}%` }}
              />
            </div>
            <span style={styles.strengthHint}>
              {strength < 50
                ? "Fill more fields to attract better matches"
                : strength < 90
                ? "Looking great — almost there!"
                : "Excellent — your profile is complete 🎉"}
            </span>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div style={styles.statsRow}>
        <StatCard label="Applications" value={stats.applied} accent="#7c3aed" />
        <StatCard
          label="Interviews"
          value={stats.interviews}
          accent="#06b6d4"
          hint={
            stats.interviews === 0 ? "Track applications to see this" : null
          }
        />
        <StatCard label="Saved Jobs" value={stats.saved} accent="#10b981" />
        <StatCard
          label="Response Rate"
          value={stats.response_rate === null ? "—" : `${stats.response_rate}%`}
          accent="#f59e0b"
          hint={
            stats.response_rate === null
              ? "No applications yet"
              : stats.response_rate === 0
              ? "Update statuses in Activity History to track this"
              : null
          }
        />
      </div>

      {/* Save notice */}
      {saveNotice && <div style={styles.notice}>{saveNotice}</div>}
      {errorMsg && <div style={styles.error}>{errorMsg}</div>}
      {isLoading && <div style={styles.loading}>Loading your profile…</div>}

      {/* Tab bar */}
      <div style={styles.tabBar}>
        <button
          style={{
            ...styles.tabBtn,
            ...(activeTab === "profile" ? styles.tabBtnActive : {}),
          }}
          onClick={() => setActiveTab("profile")}
        >
          👤 Profile
        </button>
        <button
          style={{
            ...styles.tabBtn,
            ...(activeTab === "activity" ? styles.tabBtnActive : {}),
          }}
          onClick={() => setActiveTab("activity")}
        >
          📋 Activity History
          {allActivity.length > 0 && (
            <span style={styles.tabBadge}>{allActivity.length}</span>
          )}
        </button>
      </div>

      {/* Activity History tab */}
      {activeTab === "activity" && (
        <div style={styles.activityTabWrap}>
          {/* Status notice (accepted toast, delete confirm, etc.) */}
          {statusNotice && <div style={styles.statusNotice}>{statusNotice}</div>}

          {/* Filter tabs */}
          <div style={styles.filterBar}>
            {[
              { key: "all",       label: "All" },
              { key: "saved",     label: "🔖 Saved" },
              { key: "applied",   label: "📤 Applied" },
              { key: "interview", label: "🎤 Interview" },
              { key: "offer",     label: "📋 Offer" },
            ].map(({ key, label }) => (
              <button
                key={key}
                style={{
                  ...styles.filterBtn,
                  ...(activityFilter === key ? styles.filterBtnActive : {}),
                }}
                onClick={() => setActivityFilter(key)}
              >
                {label}
                {filterCounts[key] > 0 && (
                  <span style={styles.filterCount}>{filterCounts[key]}</span>
                )}
              </button>
            ))}
          </div>

          {/* List */}
          {allActivity.length === 0 ? (
            <div style={styles.activityTabEmpty}>
              <p>No saves or applications in the last 6 months.</p>
              <p style={{ marginTop: "8px", fontSize: "13px" }}>
                Go to the{" "}
                <span
                  style={{ color: "#7c3aed", cursor: "pointer", textDecoration: "underline" }}
                  onClick={() => navigate("/home")}
                >
                  job board
                </span>{" "}
                and start saving or applying!
              </p>
            </div>
          ) : filteredActivity.length === 0 ? (
            <div style={styles.activityTabEmpty}>
              <p>No items in this category yet.</p>
            </div>
          ) : (
            <div style={styles.activityList}>
              {filteredActivity.map((item, i) => (
                <div key={item.activity_id || i} style={styles.activityRow}>

                  {/* Left: status badge (saved) or status select (applied) */}
                  {item.kind === "save" ? (
                    <div style={{ ...styles.activityBadge, background: "#e0e7ff", color: "#3730a3", borderColor: "#c7d2fe" }}>
                      🔖 Saved
                    </div>
                  ) : (
                    <select
                      style={{
                        ...styles.statusSelect,
                        ...STATUS_STYLE[item.status] || STATUS_STYLE.applied,
                      }}
                      value={item.status || "applied"}
                      onChange={(e) => handleStatusChange(item, e.target.value)}
                    >
                      {STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  )}

                  {/* Middle: title + meta */}
                  <div style={styles.activityRowBody}>
                    <div style={styles.activityRowTitle}>
                      {item.title || "Untitled position"}
                    </div>
                    <div style={styles.activityRowMeta}>
                      {[item.company, item.location].filter(Boolean).join(" · ")}
                    </div>
                  </div>

                  {/* Right: date + view link + delete */}
                  <div style={styles.activityRowRight}>
                    <div style={styles.activityRowDate}>
                      {item.timestamp
                        ? new Date(item.timestamp).toLocaleDateString("en-GB", {
                            day: "numeric", month: "short", year: "numeric",
                          })
                        : "—"}
                    </div>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      {item.job_url && (
                        <a href={item.job_url} target="_blank" rel="noopener noreferrer" style={styles.activityRowLink}>
                          View ↗
                        </a>
                      )}
                      <button
                        style={styles.deleteBtn}
                        onClick={() => handleDeleteItem(item)}
                        title="Remove from history"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Two-column layout — only shown on Profile tab */}
      {activeTab === "profile" && <div style={styles.twoCol}>
        <div style={styles.colMain}>
          {/* Personal Info */}
          <Section icon="👤" title="Personal Info" onSave={savePersonal}>
            <Row>
              <Field
                label="First name"
                required
                value={form.first_name}
                onChange={(v) => setForm({ ...form, first_name: v })}
              />
              <Field
                label="Last name"
                required
                value={form.last_name}
                onChange={(v) => setForm({ ...form, last_name: v })}
              />
            </Row>
            <Row>
              <Field label="Email" value={email} disabled />
              <Field
                label="Phone"
                placeholder="+972 …"
                value={form.phone}
                onChange={(v) => setForm({ ...form, phone: v })}
              />
            </Row>
            <Row>
              <Field
                label="Location"
                placeholder="e.g. Tel Aviv, Israel"
                value={form.location}
                onChange={(v) => setForm({ ...form, location: v })}
              />
            </Row>
          </Section>

          {/* Professional */}
          <Section icon="💼" title="Professional Details" onSave={saveProfessional}>
            <Row>
              <Field
                label="Current title"
                placeholder="e.g. Frontend Developer"
                value={form.title}
                onChange={(v) => setForm({ ...form, title: v })}
              />
              <Field
                label="Years of experience"
                type="number"
                placeholder="0"
                value={form.years_experience}
                onChange={(v) => setForm({ ...form, years_experience: v })}
              />
            </Row>
            <Field
              label="Short bio"
              textarea
              placeholder="A few sentences about yourself…"
              value={form.bio}
              onChange={(v) => setForm({ ...form, bio: v })}
            />
          </Section>

          {/* Job Preferences */}
          <Section icon="🎯" title="Job Preferences" onSave={savePreferences}>
            <Row>
              <Field
                label="Desired role"
                placeholder="e.g. Backend Engineer"
                value={form.desired_role}
                onChange={(v) => setForm({ ...form, desired_role: v })}
              />
              <Select
                label="Work mode"
                value={form.work_mode}
                options={[
                  { value: "", label: "Any" },
                  { value: "remote", label: "Remote" },
                  { value: "hybrid", label: "Hybrid" },
                  { value: "onsite", label: "Onsite" },
                ]}
                onChange={(v) => setForm({ ...form, work_mode: v })}
              />
            </Row>
            <Row>
              <Field
                label="Min salary (USD/yr)"
                type="number"
                placeholder="80000"
                value={form.desired_salary_min}
                onChange={(v) => setForm({ ...form, desired_salary_min: v })}
              />
              <Field
                label="Max salary (USD/yr)"
                type="number"
                placeholder="140000"
                value={form.desired_salary_max}
                onChange={(v) => setForm({ ...form, desired_salary_max: v })}
              />
            </Row>
          </Section>

          {/* Skills */}
          <Section icon="⚡" title="Skills" onSave={saveSkills}>
            <div style={styles.skillsWrap}>
              {skills.length === 0 && (
                <span style={styles.skillsEmpty}>
                  No skills yet — add some below.
                </span>
              )}
              {skills.map((s) => (
                <span key={s} style={styles.skillChip}>
                  {s}
                  <button
                    style={styles.skillRemove}
                    onClick={() => handleRemoveSkill(s)}
                    aria-label={`Remove ${s}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div style={styles.skillInputRow}>
              <input
                style={styles.skillInput}
                placeholder="e.g. React, Python, AWS…"
                value={skillInput}
                onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddSkill();
                  }
                }}
              />
              <button style={styles.skillAdd} onClick={handleAddSkill}>
                + Add
              </button>
            </div>
          </Section>

          {/* Resume / CV Files */}
          <Section icon="📄" title="My Resume">

            {/* ── Upload in progress ── */}
            {(cvState.status === "reading" || cvState.status === "extracting") && (
              <div style={styles.cvProcessing}>
                <div style={styles.cvSpinner} />
                <div>
                  <div style={styles.cvProcessTitle}>
                    {cvState.status === "reading"
                      ? "Uploading & reading your PDF…"
                      : "AI is extracting your profile data…"}
                  </div>
                  <div style={styles.cvProcessSub}>{cvState.fileName}</div>
                </div>
              </div>
            )}

            {/* ── Upload error ── */}
            {cvState.status === "error" && (
              <div style={styles.cvError}>
                <span style={{ fontSize: "20px", flexShrink: 0 }}>⚠️</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: "700", fontSize: "13px", color: "#991b1b", marginBottom: "2px" }}>
                    Upload failed
                  </div>
                  <div style={{ fontSize: "12px", color: "#b91c1c" }}>{cvState.error}</div>
                </div>
                <button
                  style={styles.resumeUploadBtn}
                  onClick={() => {
                    setCvState({ status: "idle", data: null, fileName: null, error: null });
                    cvFileRef.current?.click();
                  }}
                >
                  Try again
                </button>
              </div>
            )}

            {/* ── Extracted data preview + apply ── */}
            {cvState.status === "done" && cvState.data && (
              <div style={styles.cvDone}>
                <div style={styles.cvDoneHeader}>
                  <span style={{ fontSize: "22px" }}>✅</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: "700", fontSize: "13px", color: "#065f46" }}>
                      CV uploaded &amp; extracted!
                    </div>
                    <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>
                      {cvState.fileName}
                    </div>
                  </div>
                  <button
                    style={{ ...styles.resumeUploadBtn, fontSize: "11px", padding: "6px 12px" }}
                    onClick={() => setCvState({ status: "idle", data: null, fileName: null, error: null })}
                  >
                    Dismiss
                  </button>
                </div>
                <div style={styles.cvPreview}>
                  {cvState.data.first_name && (
                    <CvField label="Name" value={[cvState.data.first_name, cvState.data.last_name].filter(Boolean).join(" ")} />
                  )}
                  {cvState.data.title && <CvField label="Title" value={cvState.data.title} />}
                  {cvState.data.years_experience != null && (
                    <CvField label="Experience" value={`${cvState.data.years_experience} year${cvState.data.years_experience !== 1 ? "s" : ""}`} />
                  )}
                  {cvState.data.location && <CvField label="Location" value={cvState.data.location} />}
                  {cvState.data.desired_role && <CvField label="Desired role" value={cvState.data.desired_role} />}
                  {Array.isArray(cvState.data.skills) && cvState.data.skills.length > 0 && (
                    <CvField
                      label="Skills"
                      value={cvState.data.skills.slice(0, 8).join(", ") + (cvState.data.skills.length > 8 ? ` +${cvState.data.skills.length - 8} more` : "")}
                    />
                  )}
                  {cvState.data.bio && <CvField label="Bio" value={cvState.data.bio} />}
                </div>
                <button style={styles.cvApplyBtn} onClick={handleApplyCV}>
                  ✨ Apply to profile &amp; Save
                </button>
              </div>
            )}

            {/* ── Documents list ── */}
            {documents.length === 0 && cvState.status === "idle" && (
              <div style={styles.resumeBox}>
                <div style={styles.resumeIcon}>📄</div>
                <div style={{ flex: 1 }}>
                  <div style={styles.resumeTitle}>No CVs uploaded yet</div>
                  <div style={styles.resumeSub}>
                    Upload your PDF — AI will auto-fill your profile and your file will be saved securely.
                  </div>
                </div>
              </div>
            )}

            {documents.length > 0 && (
              <div style={styles.docList}>
                {documents.map((doc) => (
                  <div key={doc.doc_id} style={styles.docRow}>
                    <span style={{ fontSize: "24px", flexShrink: 0 }}>📄</span>
                    <div style={styles.docInfo}>
                      <div style={styles.docName}>{doc.file_name}</div>
                      <div style={styles.docDate}>
                        {doc.uploaded_at
                          ? new Date(doc.uploaded_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
                          : ""}
                      </div>
                    </div>
                    {doc.is_primary && <span style={styles.primaryBadge}>⭐ Primary</span>}
                    <div style={styles.docActions}>
                      {!doc.is_primary && (
                        <button style={styles.docActionBtn} onClick={() => handleSetPrimary(doc)}>
                          Set primary
                        </button>
                      )}
                      <button style={styles.docActionBtn} onClick={() => handleDownload(doc)}>
                        ↓ Download
                      </button>
                      <button style={styles.docDeleteBtn} onClick={() => handleDeleteDocument(doc)}>
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Upload button ── */}
            <button
              style={{
                ...styles.resumeUploadBtn,
                width: "100%",
                marginTop: documents.length > 0 || cvState.status !== "idle" ? "12px" : "0",
                opacity: (cvState.status === "reading" || cvState.status === "extracting") ? 0.5 : 1,
              }}
              onClick={() => cvFileRef.current?.click()}
              disabled={cvState.status === "reading" || cvState.status === "extracting"}
            >
              + Upload CV
            </button>

          </Section>
        </div>

        {/* Right column */}
        <div style={styles.colSide}>
          <Card title="Quick actions">
            <div style={styles.qaGrid}>
              <button style={styles.qaBtn} onClick={() => navigate("/home")}>
                🔍 Find jobs
              </button>
              <button
                style={{ ...styles.qaBtn, ...styles.qaBtnActive }}
                onClick={() => {
                  setActiveTab("profile");
                  // Small delay to ensure the profile tab (and the file input) is mounted
                  setTimeout(() => cvFileRef.current?.click(), 50);
                }}
              >
                📄 Upload CV
              </button>
              <button style={styles.qaBtn} disabled title="Coming in Phase 2">
                ✍️ Cover letter
              </button>
              <button style={styles.qaBtn} disabled title="Coming in Phase 2">
                🎤 Mock interview
              </button>
            </div>
            <p style={styles.qaNote}>
              ✨ Upload your CV and AI will auto-fill your profile in seconds.
            </p>
          </Card>

          <Card title="Recent activity">
            {recent.length === 0 ? (
              <p style={styles.activityEmpty}>
                No activity yet. Save or apply to a job from the home page to
                see it here.
              </p>
            ) : (
              <div>
                {recent.map((a, i) => (
                  <div key={i} style={styles.activityItem}>
                    <div
                      style={{
                        ...styles.activityIcon,
                        background:
                          a.kind === "apply" ? "#fef3c7" : "#e0e7ff",
                      }}
                    >
                      {a.kind === "apply" ? "📤" : "🔖"}
                    </div>
                    <div style={styles.activityText}>
                      <strong>
                        {a.kind === "apply" ? "Applied to" : "Saved"}
                      </strong>{" "}
                      {a.title}
                      {a.company ? ` · ${a.company}` : ""}
                    </div>
                    <div style={styles.activityTime}>
                      {a.timestamp
                        ? new Date(a.timestamp).toLocaleDateString()
                        : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Account">
            <div style={styles.accountRow}>
              <span style={styles.accountKey}>User ID</span>
              <span style={styles.accountVal}>
                {userId ? userId.slice(0, 8) + "…" : "—"}
              </span>
            </div>
            <div style={styles.accountRow}>
              <span style={styles.accountKey}>Email</span>
              <span style={styles.accountVal}>{email || "—"}</span>
            </div>
          </Card>
        </div>
      </div>}

      {/* Hidden CV file input — always mounted so Quick Actions can trigger it */}
      <input
        ref={cvFileRef}
        type="file"
        accept=".pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleCVFile(file);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />

      {/* ── Custom confirm modal (replaces window.confirm) ── */}
      {confirmModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div style={styles.modalIcon}>⚠️</div>
            <p style={styles.modalMessage}>{confirmModal.message}</p>
            <div style={styles.modalBtns}>
              <button
                style={styles.modalCancel}
                onClick={() => setConfirmModal(null)}
              >
                Cancel
              </button>
              <button
                style={styles.modalConfirm}
                onClick={() => {
                  setConfirmModal(null);
                  confirmModal.onConfirm();
                }}
              >
                {confirmModal.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Reusable bits ---------- */

function Section({ icon, title, children, onSave }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <div style={styles.sectionTitleWrap}>
          <span style={styles.sectionIcon}>{icon}</span>
          <h3 style={styles.sectionTitle}>{title}</h3>
        </div>
        {onSave && (
          <button style={styles.sectionSave} onClick={onSave}>
            Save
          </button>
        )}
      </div>
      <div style={styles.sectionBody}>{children}</div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={styles.card}>
      <h3 style={styles.cardTitle}>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

function Row({ children }) {
  return <div style={styles.row}>{children}</div>;
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  disabled,
  textarea,
  required,
}) {
  return (
    <label style={styles.fieldLabel}>
      <span style={styles.fieldLabelText}>
        {label}
        {required && <span style={styles.requiredStar}> *</span>}
      </span>
      {textarea ? (
        <textarea
          style={{ ...styles.input, ...styles.textarea }}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
        />
      ) : (
        <input
          style={{
            ...styles.input,
            ...(disabled ? styles.inputDisabled : {}),
          }}
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
        />
      )}
    </label>
  );
}

function Select({ label, value, options, onChange }) {
  return (
    <label style={styles.fieldLabel}>
      <span style={styles.fieldLabelText}>{label}</span>
      <select
        style={styles.input}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatCard({ label, value, accent, hint }) {
  return (
    <div style={styles.statCard}>
      <div style={{ ...styles.statAccent, background: accent }} />
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>{value}</span>
      {hint && <span style={styles.statHint}>{hint}</span>}
    </div>
  );
}

function CvField({ label, value }) {
  return (
    <div style={styles.cvPreviewField}>
      <span style={styles.cvPreviewLabel}>{label}</span>
      <span style={styles.cvPreviewValue}>{value}</span>
    </div>
  );
}

/* ---------- Styles ---------- */

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f3f4f6",
    paddingBottom: "60px",
  },
  header: {
    background: "#ffffff",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    padding: "14px 32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    cursor: "pointer",
  },
  logo: { width: "70px" },
  backLink: {
    fontSize: "13px",
    color: "#7c3aed",
    fontWeight: "600",
  },
  logoutBtn: {
    background: "transparent",
    border: "none",
    fontSize: "12px",
    color: "#9ca3af",
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },

  heroWrap: {
    position: "relative",
    margin: "24px auto 20px",
    maxWidth: "1100px",
    padding: "0 24px",
  },
  heroGlow: {
    position: "absolute",
    inset: "8px 24px 8px 24px",
    borderRadius: "24px",
    background: "linear-gradient(135deg, rgba(124,58,237,0.35), rgba(6,182,212,0.35))",
    filter: "blur(24px)",
    zIndex: 0,
  },
  hero: {
    position: "relative",
    background:
      "linear-gradient(135deg, #7c3aed 0%, #5b21b6 45%, #06b6d4 100%)",
    borderRadius: "20px",
    padding: "28px 32px",
    color: "white",
    display: "flex",
    alignItems: "center",
    gap: "24px",
    boxShadow: "0 12px 36px rgba(124,58,237,0.3)",
    flexWrap: "wrap",
  },
  heroAvatar: {
    position: "relative",
    width: "84px",
    height: "84px",
    borderRadius: "50%",
    background: "rgba(255,255,255,0.2)",
    border: "3px solid rgba(255,255,255,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    backdropFilter: "blur(8px)",
  },
  heroAvatarLetter: {
    fontSize: "34px",
    fontWeight: "800",
    color: "white",
    textShadow: "0 2px 6px rgba(0,0,0,0.2)",
  },
  heroAvatarDot: {
    position: "absolute",
    bottom: "4px",
    right: "4px",
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    background: "#10b981",
    border: "3px solid white",
  },
  heroText: { flex: 1, minWidth: "200px" },
  heroEyebrow: {
    fontSize: "11px",
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: "1px",
    opacity: 0.85,
  },
  heroName: {
    fontSize: "28px",
    fontWeight: "800",
    margin: "4px 0 4px 0",
  },
  heroSub: {
    fontSize: "14px",
    margin: 0,
    opacity: 0.9,
  },
  heroPhone: {
    fontSize: "13px",
    margin: "6px 0 0 0",
    opacity: 0.85,
  },
  heroStrength: {
    minWidth: "240px",
    background: "rgba(255,255,255,0.15)",
    backdropFilter: "blur(10px)",
    borderRadius: "14px",
    padding: "14px 16px",
    border: "1px solid rgba(255,255,255,0.25)",
  },
  strengthRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "8px",
  },
  strengthLabel: { fontSize: "12px", opacity: 0.9, fontWeight: "600" },
  strengthValue: { fontSize: "20px", fontWeight: "800" },
  progressBar: {
    height: "8px",
    background: "rgba(255,255,255,0.25)",
    borderRadius: "999px",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg, #ffffff, #a7f3d0)",
    borderRadius: "999px",
    transition: "width 0.4s ease",
  },
  strengthHint: {
    display: "block",
    marginTop: "8px",
    fontSize: "11px",
    opacity: 0.85,
  },

  statsRow: {
    maxWidth: "1100px",
    margin: "0 auto 20px",
    padding: "0 24px",
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "12px",
  },
  statCard: {
    position: "relative",
    background: "#ffffff",
    borderRadius: "14px",
    padding: "16px 18px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
    border: "1px solid #eef0f4",
    overflow: "hidden",
  },
  statAccent: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "3px",
  },
  statLabel: {
    display: "block",
    fontSize: "12px",
    color: "#6b7280",
    fontWeight: "600",
    marginBottom: "6px",
    marginTop: "4px",
  },
  statValue: {
    display: "block",
    fontSize: "26px",
    fontWeight: "800",
    color: "#111827",
  },
  statHint: {
    display: "block",
    fontSize: "11px",
    color: "#9ca3af",
    marginTop: "4px",
  },

  notice: {
    maxWidth: "1100px",
    margin: "0 auto 12px",
    padding: "10px 16px",
    background: "#fef3c7",
    border: "1px solid #fde68a",
    color: "#92400e",
    borderRadius: "10px",
    fontSize: "13px",
    marginLeft: "24px",
    marginRight: "24px",
  },
  error: {
    maxWidth: "1100px",
    margin: "0 24px 12px",
    padding: "10px 16px",
    background: "#fee2e2",
    border: "1px solid #fecaca",
    color: "#991b1b",
    borderRadius: "10px",
    fontSize: "13px",
  },
  loading: {
    maxWidth: "1100px",
    margin: "0 24px 12px",
    fontSize: "13px",
    color: "#6b7280",
    textAlign: "center",
    padding: "10px",
  },

  twoCol: {
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "0 24px",
    display: "grid",
    gridTemplateColumns: "1fr 320px",
    gap: "16px",
  },
  colMain: { display: "flex", flexDirection: "column", gap: "16px" },
  colSide: { display: "flex", flexDirection: "column", gap: "16px" },

  section: {
    background: "#ffffff",
    borderRadius: "16px",
    border: "1px solid #eef0f4",
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
    overflow: "hidden",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid #f3f4f6",
  },
  sectionTitleWrap: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  sectionIcon: { fontSize: "18px" },
  sectionTitle: {
    fontSize: "15px",
    fontWeight: "700",
    color: "#1f2937",
    margin: 0,
  },
  sectionSave: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "8px",
    padding: "6px 14px",
    fontSize: "12px",
    fontWeight: "700",
    cursor: "pointer",
    boxShadow: "0 3px 10px rgba(124,58,237,0.3)",
  },
  sectionBody: {
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
  },
  fieldLabel: { display: "flex", flexDirection: "column", gap: "4px" },
  fieldLabelText: {
    fontSize: "12px",
    fontWeight: "600",
    color: "#6b7280",
  },
  requiredStar: {
    color: "#dc2626",
    fontWeight: "700",
    marginLeft: "2px",
  },
  input: {
    padding: "10px 12px",
    fontSize: "14px",
    borderRadius: "10px",
    border: "1px solid #d1d5db",
    outline: "none",
    background: "#ffffff",
    fontFamily: "inherit",
  },
  inputDisabled: {
    background: "#f9fafb",
    color: "#6b7280",
    cursor: "not-allowed",
  },
  textarea: {
    minHeight: "80px",
    resize: "vertical",
  },

  skillsWrap: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    minHeight: "30px",
  },
  skillsEmpty: { fontSize: "13px", color: "#9ca3af" },
  skillChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    background: "linear-gradient(135deg, #f3e8ff 0%, #cffafe 100%)",
    border: "1px solid #ddd6fe",
    color: "#5b21b6",
    fontSize: "13px",
    fontWeight: "600",
    padding: "5px 10px",
    borderRadius: "999px",
  },
  skillRemove: {
    background: "transparent",
    border: "none",
    color: "#7c3aed",
    cursor: "pointer",
    fontSize: "16px",
    lineHeight: 1,
    padding: 0,
  },
  skillInputRow: { display: "flex", gap: "8px", marginTop: "10px" },
  skillInput: {
    flex: 1,
    padding: "10px 12px",
    fontSize: "14px",
    borderRadius: "10px",
    border: "1px solid #d1d5db",
    outline: "none",
  },
  skillAdd: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "10px",
    padding: "0 16px",
    fontSize: "13px",
    fontWeight: "700",
    cursor: "pointer",
  },

  resumeBox: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    background: "#f9fafb",
    borderRadius: "12px",
    padding: "14px",
    border: "1px dashed #d1d5db",
  },
  resumeIcon: { fontSize: "32px" },
  resumeTitle: { fontSize: "14px", fontWeight: "700", color: "#1f2937" },
  resumeSub: {
    fontSize: "12px",
    color: "#6b7280",
    marginTop: "2px",
  },
  resumeUploadBtn: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "#fff",
    border: "none",
    borderRadius: "10px",
    padding: "9px 16px",
    fontSize: "13px",
    fontWeight: "700",
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxShadow: "0 3px 10px rgba(124,58,237,0.3)",
    flexShrink: 0,
  },

  // CV processing / extracting state
  cvProcessing: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    background: "#f5f3ff",
    borderRadius: "12px",
    padding: "18px 20px",
    border: "1px solid #ddd6fe",
  },
  cvSpinner: {
    width: "28px",
    height: "28px",
    borderRadius: "50%",
    border: "3px solid #ddd6fe",
    borderTopColor: "#7c3aed",
    animation: "spin 0.8s linear infinite",
    flexShrink: 0,
  },
  cvProcessTitle: {
    fontSize: "14px",
    fontWeight: "700",
    color: "#5b21b6",
  },
  cvProcessSub: {
    fontSize: "12px",
    color: "#7c3aed",
    marginTop: "2px",
  },

  // CV error state
  cvError: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    background: "#fff1f2",
    borderRadius: "12px",
    padding: "14px 16px",
    border: "1px solid #fecaca",
  },

  // CV done state
  cvDone: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    background: "#f0fdf4",
    borderRadius: "12px",
    padding: "16px",
    border: "1px solid #bbf7d0",
  },
  cvDoneHeader: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  cvPreview: {
    display: "flex",
    flexDirection: "column",
    gap: "0",
    background: "#ffffff",
    borderRadius: "10px",
    border: "1px solid #d1fae5",
    overflow: "hidden",
  },
  cvPreviewField: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    padding: "8px 12px",
    borderBottom: "1px solid #f3f4f6",
    fontSize: "13px",
  },
  cvPreviewLabel: {
    minWidth: "90px",
    fontWeight: "700",
    color: "#6b7280",
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    flexShrink: 0,
  },
  cvPreviewValue: {
    color: "#111827",
    lineHeight: 1.4,
    flex: 1,
  },
  cvApplyBtn: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "#fff",
    border: "none",
    borderRadius: "12px",
    padding: "13px",
    fontSize: "14px",
    fontWeight: "700",
    cursor: "pointer",
    width: "100%",
    boxShadow: "0 4px 14px rgba(124,58,237,0.35)",
  },

  // Document list
  docList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  docRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    padding: "12px 14px",
  },
  docInfo: {
    flex: 1,
    minWidth: 0,
  },
  docName: {
    fontSize: "13px",
    fontWeight: "700",
    color: "#111827",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  docDate: {
    fontSize: "11px",
    color: "#9ca3af",
    marginTop: "2px",
  },
  primaryBadge: {
    flexShrink: 0,
    fontSize: "11px",
    fontWeight: "700",
    color: "#92400e",
    background: "#fef3c7",
    border: "1px solid #fde68a",
    borderRadius: "999px",
    padding: "3px 10px",
    whiteSpace: "nowrap",
  },
  docActions: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexShrink: 0,
  },
  docActionBtn: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: "8px",
    padding: "5px 10px",
    fontSize: "11px",
    fontWeight: "600",
    color: "#374151",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  docDeleteBtn: {
    background: "transparent",
    border: "none",
    fontSize: "15px",
    cursor: "pointer",
    opacity: 0.45,
    padding: "4px",
    lineHeight: 1,
  },

  card: {
    background: "#ffffff",
    borderRadius: "16px",
    border: "1px solid #eef0f4",
    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
    padding: "16px 18px",
  },
  cardTitle: {
    margin: "0 0 12px 0",
    fontSize: "14px",
    fontWeight: "700",
    color: "#1f2937",
  },
  qaGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "8px",
  },
  qaBtn: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "10px 12px",
    fontSize: "12px",
    fontWeight: "600",
    color: "#374151",
    cursor: "pointer",
    textAlign: "left",
  },
  qaBtnActive: {
    background: "linear-gradient(135deg, #f3e8ff 0%, #cffafe 100%)",
    border: "1px solid #ddd6fe",
    color: "#5b21b6",
    cursor: "pointer",
  },
  qaNote: {
    fontSize: "11px",
    color: "#9ca3af",
    margin: "10px 0 0 0",
    lineHeight: 1.4,
  },
  activityEmpty: {
    fontSize: "13px",
    color: "#9ca3af",
    margin: 0,
    lineHeight: 1.5,
  },
  activityItem: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 0",
    borderBottom: "1px solid #f3f4f6",
  },
  activityIcon: {
    width: "30px",
    height: "30px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    flexShrink: 0,
  },
  activityText: {
    flex: 1,
    fontSize: "12px",
    color: "#6b7280",
    lineHeight: 1.4,
  },
  activityTime: {
    fontSize: "11px",
    color: "#9ca3af",
    flexShrink: 0,
  },
  accountRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "12px",
    padding: "6px 0",
    borderBottom: "1px solid #f3f4f6",
  },
  accountKey: { color: "#6b7280", fontWeight: "600" },
  accountVal: { color: "#111827", fontFamily: "monospace" },

  // ── Tab bar ────────────────────────────────────────────────────────────────
  tabBar: {
    maxWidth: "1100px",
    margin: "0 auto 20px",
    padding: "0 24px",
    display: "flex",
    gap: "8px",
  },
  tabBtn: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "9px 18px",
    fontSize: "13px",
    fontWeight: "600",
    color: "#6b7280",
    cursor: "pointer",
    transition: "all 0.15s",
  },
  tabBtnActive: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    border: "1px solid transparent",
    color: "#ffffff",
    boxShadow: "0 3px 12px rgba(124,58,237,0.3)",
  },
  tabBadge: {
    background: "rgba(255,255,255,0.25)",
    borderRadius: "999px",
    padding: "1px 7px",
    fontSize: "11px",
    fontWeight: "700",
  },

  // ── Activity tab ────────────────────────────────────────────────────────────
  activityTabWrap: {
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "0 24px 40px",
  },
  activityTabHeading: {
    fontSize: "15px",
    fontWeight: "700",
    color: "#1f2937",
    margin: "0 0 16px",
  },
  activityTabEmpty: {
    background: "#ffffff",
    border: "1px solid #eef0f4",
    borderRadius: "16px",
    padding: "48px 24px",
    textAlign: "center",
    color: "#6b7280",
    fontSize: "14px",
  },
  activityList: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  activityRow: {
    background: "#ffffff",
    border: "1px solid #eef0f4",
    borderRadius: "14px",
    padding: "14px 18px",
    display: "flex",
    alignItems: "center",
    gap: "14px",
    boxShadow: "0 2px 6px rgba(0,0,0,0.03)",
  },
  activityBadge: {
    flexShrink: 0,
    fontSize: "11px",
    fontWeight: "700",
    padding: "4px 10px",
    borderRadius: "999px",
    border: "1px solid",
    whiteSpace: "nowrap",
  },
  activityRowBody: {
    flex: 1,
    minWidth: 0,
  },
  activityRowTitle: {
    fontSize: "14px",
    fontWeight: "700",
    color: "#111827",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  activityRowMeta: {
    fontSize: "12px",
    color: "#6b7280",
    marginTop: "2px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  activityRowRight: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "4px",
  },
  activityRowDate: {
    fontSize: "12px",
    color: "#9ca3af",
    whiteSpace: "nowrap",
  },
  activityRowLink: {
    fontSize: "12px",
    color: "#7c3aed",
    fontWeight: "600",
    textDecoration: "none",
  },
  statusSelect: {
    flexShrink: 0,
    fontSize: "11px",
    fontWeight: "700",
    padding: "5px 10px",
    borderRadius: "999px",
    border: "1px solid",
    cursor: "pointer",
    outline: "none",
    appearance: "none",       // hide default OS arrow
    WebkitAppearance: "none",
    backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E\")",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 8px center",
    paddingRight: "24px",
  },
  deleteBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "15px",
    opacity: 0.45,
    padding: "2px 4px",
    lineHeight: 1,
    transition: "opacity 0.15s",
  },
  statusNotice: {
    maxWidth: "1100px",
    margin: "0 auto 12px",
    padding: "10px 16px",
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    color: "#166534",
    borderRadius: "10px",
    fontSize: "13px",
    fontWeight: "600",
  },
  // ── Filter bar ──────────────────────────────────────────────────────────────
  filterBar: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginBottom: "16px",
  },
  filterBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: "999px",
    padding: "6px 14px",
    fontSize: "12px",
    fontWeight: "600",
    color: "#6b7280",
    cursor: "pointer",
  },
  filterBtnActive: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    border: "1px solid transparent",
    color: "#ffffff",
    boxShadow: "0 2px 8px rgba(124,58,237,0.25)",
  },
  filterCount: {
    background: "rgba(255,255,255,0.25)",
    borderRadius: "999px",
    padding: "1px 6px",
    fontSize: "10px",
    fontWeight: "700",
  },

  // ── Confirm modal ────────────────────────────────────────────────────────────
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modalCard: {
    background: "#ffffff",
    borderRadius: "20px",
    padding: "36px 32px 28px",
    maxWidth: "400px",
    width: "90%",
    boxShadow: "0 24px 60px rgba(0,0,0,0.2)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
    textAlign: "center",
  },
  modalIcon: {
    fontSize: "40px",
    lineHeight: 1,
  },
  modalMessage: {
    margin: 0,
    fontSize: "15px",
    color: "#374151",
    lineHeight: 1.6,
  },
  modalBtns: {
    display: "flex",
    gap: "12px",
    marginTop: "4px",
    width: "100%",
  },
  modalCancel: {
    flex: 1,
    padding: "11px",
    borderRadius: "12px",
    border: "1px solid #e5e7eb",
    background: "#f9fafb",
    color: "#374151",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
  },
  modalConfirm: {
    flex: 1,
    padding: "11px",
    borderRadius: "12px",
    border: "none",
    background: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)",
    color: "#ffffff",
    fontSize: "14px",
    fontWeight: "700",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(220,38,38,0.35)",
  },
};
