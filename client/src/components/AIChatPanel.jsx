// UPply — AI Career Agent chat panel
// A floating sidebar that lets the user chat with an OpenAI-powered career agent.
// The agent knows the user's full profile and can act on their behalf through
// tools that invoke the other UPply Lambdas (search jobs, save/apply, edit
// profile, analyse fit …). Conversation history is persisted in sessionStorage
// so it survives page navigation.
//
// Props:
//   userId        — Cognito sub of the signed-in user
//   onDataChanged — optional callback fired after the agent changes stored data
//                   (saved jobs, applications, profile), so the host page can refresh

import { useState, useEffect, useRef } from "react";
import { askAI } from "../services/api";

// Chat history is stored per-user so switching accounts in the same tab never
// shows one user another user's conversation (and the agent never answers with
// the wrong profile in context).
const storageKey = (uid) => `upply_ai_chat_${uid || "anon"}`;
const MAX_HISTORY = 12; // last 6 exchanges sent as context

// Kept broad and profile-agnostic — every user sees the same prompts, and the
// agent fills in the specifics (skills, target role, gaps) from their profile.
const QUICK_PROMPTS = [
  "How should I prepare for interviews?",
  "Find jobs that match my profile and save the best 3",
  "Find remote jobs that fit my background",
  "What salary should I ask for?",
  "What are my biggest strengths and gaps as a candidate?",
];

export default function AIChatPanel({ userId, onDataChanged }) {
  const [isOpen, setIsOpen]     = useState(false);
  const [input, setInput]       = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState([]);

  const bottomRef   = useRef(null);
  const inputRef    = useRef(null);
  const messagesRef = useRef(null);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 300);
  }, [isOpen]);

  // Load this user's own history whenever the account changes (login / switch /
  // logout). A different user starts from their own slot, never the previous one.
  useEffect(() => {
    try { setMessages(JSON.parse(sessionStorage.getItem(storageKey(userId)) || "[]")); }
    catch { setMessages([]); }
  }, [userId]);

  // Persist to this user's slot only (skip while userId is still resolving, so we
  // don't write the just-loaded history into the "anon" slot).
  useEffect(() => {
    if (!userId) return;
    try { sessionStorage.setItem(storageKey(userId), JSON.stringify(messages)); }
    catch { /* storage full or unavailable — chat still works in-memory */ }
  }, [messages, userId]);

  const addMessage = (role, content, isError = false, actions = []) =>
    setMessages(prev => [...prev, { role, content, isError, actions }]);

  const send = async (text = input.trim()) => {
    if (!text || isLoading || !userId) return;
    setInput("");
    addMessage("user", text);
    setIsLoading(true);

    // Build history (everything except the message we just added)
    const history = [...messages, { role: "user", content: text }]
      .slice(-MAX_HISTORY)
      .slice(0, -1)
      .map(({ role, content }) => ({ role, content }));

    try {
      const data = await askAI(userId, text, history);
      addMessage("assistant", data.reply, false, data.actions_taken || []);
      // If the agent changed stored data, let the host page refresh its view.
      if (data.did_mutate && typeof onDataChanged === "function") onDataChanged();
    } catch {
      addMessage("assistant", "Sorry, I couldn't reach the AI service right now. Please try again in a moment.", true);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const clearChat = () => {
    setMessages([]);
    try { sessionStorage.removeItem(storageKey(userId)); } catch { /* ignore */ }
  };

  return (
    <>
      {/* ── Floating toggle button ── */}
      <button
        style={{ ...s.toggle, ...(isOpen ? s.toggleOpen : {}) }}
        onClick={() => setIsOpen(o => !o)}
        title={isOpen ? "Close AI Coach" : "Open AI Career Coach"}
      >
        <span style={s.toggleIcon}>{isOpen ? "✕" : "🤖"}</span>
        {!isOpen && <span style={s.toggleLabel}>AI Coach</span>}
        {!isOpen && messages.length > 0 && (
          <span style={s.unreadDot} />
        )}
      </button>

      {/* ── Slide-in panel ── */}
      <div style={{
        ...s.panel,
        transform: isOpen ? "translateX(0)" : "translateX(calc(100% + 24px))",
        pointerEvents: isOpen ? "auto" : "none",
      }}>

        {/* Header */}
        <div style={s.header}>
          <div style={s.headerLeft}>
            <div style={s.headerAvatar}>🤖</div>
            <div>
              <div style={s.headerTitle}>AI Career Agent</div>
              <div style={s.headerSub}>● Online · Can act on your account</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            {messages.length > 0 && (
              <button style={s.iconBtn} onClick={clearChat} title="Clear conversation">🗑️</button>
            )}
            <button style={s.iconBtn} onClick={() => setIsOpen(false)} title="Close">✕</button>
          </div>
        </div>

        {/* Messages */}
        <div style={s.messages} ref={messagesRef}>

          {/* Welcome screen */}
          {messages.length === 0 && (
            <div style={s.welcome}>
              <div style={s.welcomeEmoji}>👋</div>
              <div style={s.welcomeTitle}>Hi, I'm your Career Agent!</div>
              <div style={s.welcomeBody}>
                I know your profile and can search jobs, save or apply to them,
                update your profile and analyse your fit — just ask. Try one of these:
              </div>
              <div style={s.chips}>
                {QUICK_PROMPTS.map(p => (
                  <button key={p} style={s.chip} onClick={() => send(p)}>{p}</button>
                ))}
              </div>
            </div>
          )}

          {/* Message bubbles */}
          {messages.map((msg, i) => (
            msg.role === "user" ? (
              <div key={i} style={s.userRow}>
                <div style={s.userBubble}>{msg.content}</div>
              </div>
            ) : (
              <div key={i} style={s.aiRow}>
                <div style={s.aiAvatar}>🤖</div>
                <div style={s.aiCol}>
                  {msg.actions?.length > 0 && (
                    <div style={s.actionTrace}>
                      {msg.actions.map((a, j) => (
                        <div key={j} style={s.actionItem}>
                          <span style={s.actionCheck}>✓</span> {a}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ ...s.aiBubble, ...(msg.isError ? s.errorBubble : {}) }}>
                    <MarkdownMessage text={msg.content} />
                  </div>
                </div>
              </div>
            )
          ))}

          {/* Typing indicator */}
          {isLoading && (
            <div style={s.aiRow}>
              <div style={s.aiAvatar}>🤖</div>
              <div style={{ ...s.aiBubble, display: "flex", alignItems: "center", gap: "8px" }}>
                <span className="ai-dot" />
                <span className="ai-dot" />
                <span className="ai-dot" />
                <span style={{ fontSize: "11px", color: "#9ca3af" }}>working…</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <div style={s.inputArea}>
          <textarea
            ref={inputRef}
            style={s.textarea}
            placeholder="Ask me anything about your career…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            disabled={isLoading}
          />
          <button
            style={{ ...s.sendBtn, opacity: (!input.trim() || isLoading) ? 0.45 : 1 }}
            onClick={() => send()}
            disabled={!input.trim() || isLoading}
            title="Send (Enter)"
          >
            ↑
          </button>
        </div>
        <div style={s.inputHint}>Enter to send · Shift+Enter for new line</div>
      </div>
    </>
  );
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
// Renders GPT-style markdown without any external dependency.
// Handles: **bold**, [label](url) + bare links, bullet lists (- / • / *,
// including one level of nesting), numbered lists, ### headers.

const linkStyle = {
  color: "#7c3aed",
  fontWeight: 600,
  textDecoration: "underline",
  wordBreak: "break-all",
};

// Show a long tracking URL as just its host so it doesn't blow out the bubble.
function prettyUrl(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "") + " ↗";
  } catch {
    return u.length > 40 ? u.slice(0, 40) + "…" : u;
  }
}

function inlineFmt(text) {
  // Tokenise on **bold**, [label](url) and bare http(s) URLs.
  const re = /(\*\*[^*]+\*\*)|(\[[^\]]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s)]+)/g;
  const parts = [];
  let last = 0;
  let i = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) {
      parts.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
    } else if (m[2]) {
      const label = tok.slice(1, tok.indexOf("]"));
      const url = tok.slice(tok.indexOf("(") + 1, -1);
      parts.push(
        <a key={i++} href={url} target="_blank" rel="noopener noreferrer" style={linkStyle}>{label}</a>
      );
    } else {
      parts.push(
        <a key={i++} href={tok} target="_blank" rel="noopener noreferrer" style={linkStyle}>{prettyUrl(tok)}</a>
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MarkdownMessage({ text }) {
  const lines  = text.split("\n");
  const output = [];
  let items    = [];    // [{ text, sub }] — buffered list items
  let listType = null;  // "ul" | "ol"
  let k = 0;

  // Render the buffered list as ONE <ol>/<ul>. Keeping every item in a single
  // list is what makes an ordered list count 1, 2, 3 — the browser numbers by
  // position and ignores whatever digits the model wrote.
  const flushList = () => {
    if (items.length) {
      const Tag = listType === "ol" ? "ol" : "ul";
      output.push(
        <Tag key={k++} style={{ margin: "6px 0", paddingLeft: "22px" }}>
          {items.map((it, i) => (
            <li key={i} style={{
              marginBottom: "4px",
              lineHeight: "1.5",
              marginLeft: it.sub ? "14px" : 0,
              listStyleType: it.sub ? "circle" : undefined,
            }}>
              {inlineFmt(it.text)}
            </li>
          ))}
        </Tag>
      );
    }
    items = [];
    listType = null;
  };

  lines.forEach((raw) => {
    const line = raw.trimEnd();
    const trimmed = line.trimStart();

    // Blank line: a spacer between paragraphs, but INSIDE a list just keep the
    // list open (don't split it into one <ol> per item).
    if (!trimmed) {
      if (!items.length) output.push(<div key={k++} style={{ height: "6px" }} />);
      return;
    }

    const ul = trimmed.match(/^[-•*]\s+(.*)$/);
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);

    if (ul || ol) {
      const wantType = ol ? "ol" : "ul";
      if (listType && listType !== wantType) flushList();
      listType = wantType;

      let content = (ul ? ul[1] : ol[1]).trim();
      let sub = /^\s+/.test(raw);                 // indented item
      const nested = content.match(/^[-•*]\s+(.*)$/); // model flattened "* - text"
      if (nested) { content = nested[1].trim(); sub = true; }

      items.push({ text: content, sub });
      return;
    }

    // Indented line while a list is open → continuation of the last item.
    if (items.length && /^\s+\S/.test(raw)) {
      items[items.length - 1].text += " " + trimmed;
      return;
    }

    // Anything else closes the list.
    flushList();

    // Heading: # / ## / ###
    if (/^#{1,3}\s/.test(line)) {
      output.push(
        <div key={k++} style={{ fontWeight: "700", fontSize: "13.5px", marginTop: "8px", marginBottom: "3px" }}>
          {inlineFmt(line.replace(/^#{1,3}\s/, ""))}
        </div>
      );
      return;
    }

    // Regular paragraph line
    output.push(
      <div key={k++} style={{ lineHeight: "1.6", marginBottom: "2px" }}>
        {inlineFmt(trimmed)}
      </div>
    );
  });

  flushList();
  return <>{output}</>;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  // Toggle button
  toggle: {
    position: "fixed",
    bottom: "28px",
    right: "28px",
    zIndex: 900,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "#fff",
    border: "none",
    borderRadius: "999px",
    padding: "12px 20px 12px 16px",
    fontSize: "14px",
    fontWeight: "700",
    cursor: "pointer",
    boxShadow: "0 6px 24px rgba(124,58,237,0.45)",
    transition: "transform 0.2s, box-shadow 0.2s",
  },
  toggleOpen: {
    padding: "12px 16px",
    background: "#6b7280",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
  },
  toggleIcon: { fontSize: "18px", lineHeight: 1 },
  toggleLabel: { fontSize: "13px", fontWeight: "700" },
  unreadDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#10b981",
    border: "2px solid white",
    position: "absolute",
    top: "-2px",
    right: "-2px",
  },

  // Panel
  panel: {
    position: "fixed",
    bottom: "90px",
    right: "24px",
    width: "380px",
    height: "560px",
    zIndex: 800,
    background: "#ffffff",
    borderRadius: "20px",
    boxShadow: "0 24px 60px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    transition: "transform 0.3s cubic-bezier(0.34,1.56,0.64,1)",
  },

  // Header
  header: {
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    padding: "14px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: "10px" },
  headerAvatar: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: "rgba(255,255,255,0.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "18px",
    border: "2px solid rgba(255,255,255,0.4)",
  },
  headerTitle: { fontSize: "14px", fontWeight: "700", color: "#fff" },
  headerSub:   { fontSize: "11px", color: "rgba(255,255,255,0.8)", marginTop: "2px" },
  iconBtn: {
    background: "rgba(255,255,255,0.15)",
    border: "none",
    borderRadius: "8px",
    color: "#fff",
    fontSize: "13px",
    cursor: "pointer",
    padding: "5px 8px",
    lineHeight: 1,
  },

  // Messages area
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },

  // Welcome
  welcome: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    padding: "16px 8px",
    gap: "10px",
    flex: 1,
  },
  welcomeEmoji: { fontSize: "42px" },
  welcomeTitle: { fontSize: "16px", fontWeight: "700", color: "#1f2937" },
  welcomeBody:  { fontSize: "13px", color: "#6b7280", lineHeight: 1.5 },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "center",
    marginTop: "4px",
  },
  chip: {
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    borderRadius: "999px",
    padding: "6px 12px",
    fontSize: "12px",
    fontWeight: "600",
    color: "#374151",
    cursor: "pointer",
    transition: "background 0.15s",
  },

  // Message bubbles
  userRow: {
    display: "flex",
    justifyContent: "flex-end",
  },
  aiRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: "8px",
  },
  aiCol: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    maxWidth: "82%",
  },
  actionTrace: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    background: "#f5f3ff",
    border: "1px solid #ede9fe",
    borderRadius: "12px",
    padding: "6px 10px",
  },
  actionItem: {
    fontSize: "11px",
    color: "#6d28d9",
    fontWeight: "600",
    lineHeight: 1.4,
  },
  actionCheck: {
    color: "#10b981",
    fontWeight: "800",
    marginRight: "2px",
  },
  aiAvatar: {
    width: "28px",
    height: "28px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #7c3aed, #06b6d4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    flexShrink: 0,
  },
  userBubble: {
    maxWidth: "78%",
    background: "linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%)",
    color: "#fff",
    borderRadius: "18px 18px 4px 18px",
    padding: "10px 14px",
    fontSize: "13px",
    lineHeight: 1.5,
    wordBreak: "break-word",
  },
  aiBubble: {
    maxWidth: "82%",
    background: "#f3f4f6",
    color: "#1f2937",
    borderRadius: "18px 18px 18px 4px",
    padding: "10px 14px",
    fontSize: "13px",
    lineHeight: 1.5,
    wordBreak: "break-word",
  },
  errorBubble: {
    background: "#fee2e2",
    color: "#991b1b",
  },

  // Input area
  inputArea: {
    borderTop: "1px solid #f3f4f6",
    padding: "10px 12px 6px",
    display: "flex",
    gap: "8px",
    alignItems: "flex-end",
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    padding: "9px 12px",
    fontSize: "13px",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    resize: "none",
    outline: "none",
    fontFamily: "inherit",
    lineHeight: 1.5,
    color: "#1f2937",
    background: "#f9fafb",
  },
  sendBtn: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)",
    color: "#fff",
    border: "none",
    fontSize: "18px",
    fontWeight: "700",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "opacity 0.15s",
  },
  inputHint: {
    textAlign: "center",
    fontSize: "10px",
    color: "#9ca3af",
    padding: "0 12px 8px",
    flexShrink: 0,
  },
};
