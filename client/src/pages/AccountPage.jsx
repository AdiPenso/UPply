import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import logo from "../assets/Logo.png";
import { API_BASE_URL } from "../aws/config";

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
  const [activity, setActivity] = useState({ saved: [], applied: [] });
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

      // Profile (Users table) and activity (UserActivity table) are independent — fetch in parallel
      const [res, actRes] = await Promise.all([
        fetch(`${API_BASE_URL}/profile?user_id=${sub}`),
        fetch(`${API_BASE_URL}/activity?user_id=${sub}`),
      ]);

      if (actRes.ok) {
        const act = await actRes.json();
        setActivity({
          saved: Array.isArray(act.saved) ? act.saved : [],
          applied: Array.isArray(act.applied) ? act.applied : [],
        });
      }

      if (res.ok) {
        const raw = await res.json();
        // Handle different response shapes from profile-get Lambda:
        //   - flat object: { first_name: "Lir", ... }
        //   - DynamoDB GetItem: { Item: { first_name: "Lir", ... } }
        //   - wrapped: { profile: { first_name: "Lir", ... } }
        const data = raw?.Item || raw?.profile || raw || {};
        console.log("Loaded profile from DynamoDB:", data);
        setProfile(data);
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
      const res = await fetch(`${API_BASE_URL}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, ...cleaned }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`);
      }
      const data = await res.json();
      if (data.profile) setProfile(data.profile);
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

  // Derive a friendly fallback first name from the email when DB is empty
  // (e.g. "adi.penso16@gmail.com" → "Adi")
  const emailFirstName = email
    ? (() => {
        const raw = email.split("@")[0].split(/[._\d]/)[0];
        return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
      })()
    : "";

  // Hero always shows the SAVED state from DynamoDB — not the in-progress
  // edits — so the user's identity is stable while they edit other fields.
  const heroFirst = profile?.first_name || emailFirstName || "";
  const heroLast = profile?.last_name || "";
  const displayName =
    [heroFirst, heroLast].filter(Boolean).join(" ") || "Your name";

  const initial = (heroFirst || email || "U").charAt(0).toUpperCase();

  // Counts come from the UserActivity table (queried by /activity GET Lambda).
  // Interview count + response rate will come from the apply rows' `status` field
  // once the user updates them in the Applications page (Phase 2).
  const interviewCount = activity.applied.filter(
    (a) => a.status === "interview" || a.status === "offer"
  ).length;
  const stats = {
    applied: activity.applied.length,
    interviews: interviewCount,
    saved: activity.saved.length,
    response_rate: null,
  };

  // Merge recent activity (most recent 5 across saves + applies)
  const recent = [
    ...activity.saved.map((j) => ({ ...j, kind: "save" })),
    ...activity.applied.map((j) => ({ ...j, kind: "apply" })),
  ]
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, 5);

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
          hint={stats.response_rate === null ? "No replies tracked yet" : null}
        />
      </div>

      {/* Save notice */}
      {saveNotice && <div style={styles.notice}>{saveNotice}</div>}
      {errorMsg && <div style={styles.error}>{errorMsg}</div>}
      {isLoading && <div style={styles.loading}>Loading your profile…</div>}

      {/* Two-column layout */}
      <div style={styles.twoCol}>
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

          {/* Resume */}
          <Section icon="📄" title="My Resume">
            <div style={styles.resumeBox}>
              <div style={styles.resumeIcon}>📄</div>
              <div style={{ flex: 1 }}>
                <div style={styles.resumeTitle}>No resume uploaded</div>
                <div style={styles.resumeSub}>
                  Upload your resume to apply faster (S3 upload — coming in the
                  next step)
                </div>
              </div>
              <button style={styles.resumeBtn} disabled title="Coming soon">
                Upload PDF
              </button>
            </div>
          </Section>
        </div>

        {/* Right column */}
        <div style={styles.colSide}>
          <Card title="Quick actions">
            <div style={styles.qaGrid}>
              <button style={styles.qaBtn} onClick={() => navigate("/home")}>
                🔍 Find jobs
              </button>
              <button style={styles.qaBtn} disabled title="Coming in Phase 2">
                ✍️ Cover letter
              </button>
              <button style={styles.qaBtn} disabled title="Coming in Phase 2">
                🎤 Mock interview
              </button>
              <button style={styles.qaBtn} disabled title="Coming in Phase 2">
                🧠 AI Coach
              </button>
            </div>
            <p style={styles.qaNote}>
              ✨ AI features will be powered by Amazon Bedrock — coming after we
              wire profile saving.
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
      </div>
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
  resumeBtn: {
    background: "#e5e7eb",
    color: "#6b7280",
    border: "none",
    borderRadius: "10px",
    padding: "9px 16px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "not-allowed",
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
};
