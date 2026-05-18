// UPply — AI Career Coach chat panel
// A floating sidebar that lets the user chat with an OpenAI-powered career assistant.
// The assistant knows the user's full profile (fetched by the Lambda from DynamoDB).
// Conversation history is persisted in sessionStorage so it survives page navigation.

import { useState, useEffect, useRef } from "react";
import { askAI } from "../services/api";

const STORAGE_KEY = "upply_ai_chat";
const MAX_HISTORY = 12; // last 6 exchanges sent as context

const QUICK_PROMPTS = [
  "How can I improve my profile?",
  "What are my strongest skills?",
  "How should I prepare for interviews?",
  "What salary should I ask for?",
];

export default function AIChatPanel({ userId }) {
  const [isOpen, setIsOpen]     = useState(false);
  const [input, setInput]       = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]"); }
    catch { return []; }
  });

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

  // Persist to sessionStorage
  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages)); }
    catch {}
  }, [messages]);

  const addMessage = (role, content, isError = false) =>
    setMessages(prev => [...prev, { role, content, isError }]);

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
      const { reply } = await askAI(userId, text, history);
      addMessage("assistant", reply);
    } catch (err) {
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
    sessionStorage.removeItem(STORAGE_KEY);
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
              <div style={s.headerTitle}>AI Career Coach</div>
              <div style={s.headerSub}>● Online · Powered by GPT</div>
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
              <div style={s.welcomeTitle}>Hi, I'm your Career Coach!</div>
              <div style={s.welcomeBody}>
                I know your profile and can give you personalized advice. Try one of these:
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
            <div key={i} style={msg.role === "user" ? s.userRow : s.aiRow}>
              {msg.role === "assistant" && <div style={s.aiAvatar}>🤖</div>}
              <div style={{
                ...(msg.role === "user" ? s.userBubble : s.aiBubble),
                ...(msg.isError ? s.errorBubble : {}),
              }}>
                {msg.role === "user"
                  ? msg.content
                  : <MarkdownMessage text={msg.content} />}
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {isLoading && (
            <div style={s.aiRow}>
              <div style={s.aiAvatar}>🤖</div>
              <div style={s.aiBubble}>
                <span className="ai-dot" />
                <span className="ai-dot" />
                <span className="ai-dot" />
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
// Handles: **bold**, bullet lists (- / • / *), numbered lists, ### headers.

function inlineFmt(text) {
  // Split on **bold** patterns and render them
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part
  );
}

function MarkdownMessage({ text }) {
  const lines  = text.split("\n");
  const output = [];
  let listItems   = [];
  let listType    = null; // "ul" | "ol"
  let k = 0;

  const flushList = () => {
    if (!listItems.length) return;
    const Tag = listType === "ol" ? "ol" : "ul";
    output.push(
      <Tag key={k++} style={{ margin: "4px 0", paddingLeft: "18px" }}>
        {listItems}
      </Tag>
    );
    listItems = [];
    listType  = null;
  };

  lines.forEach((raw) => {
    const line = raw.trimEnd();

    // Unordered bullet: "- text" or "• text" or "* text"
    if (/^[-•*]\s/.test(line.trimStart())) {
      listType = "ul";
      listItems.push(
        <li key={k++} style={{ marginBottom: "3px", lineHeight: "1.5" }}>
          {inlineFmt(line.replace(/^[-•*]\s/, "").trim())}
        </li>
      );
      return;
    }

    // Ordered list: "1. text"
    if (/^\d+\.\s/.test(line.trimStart())) {
      listType = "ol";
      listItems.push(
        <li key={k++} style={{ marginBottom: "3px", lineHeight: "1.5" }}>
          {inlineFmt(line.replace(/^\d+\.\s/, "").trim())}
        </li>
      );
      return;
    }

    flushList();

    // Blank line → small spacer
    if (!line.trim()) {
      output.push(<div key={k++} style={{ height: "6px" }} />);
      return;
    }

    // Heading: # / ## / ###
    if (/^#{1,3}\s/.test(line)) {
      const content = line.replace(/^#{1,3}\s/, "");
      output.push(
        <div key={k++} style={{ fontWeight: "700", fontSize: "13.5px", marginTop: "8px", marginBottom: "3px" }}>
          {inlineFmt(content)}
        </div>
      );
      return;
    }

    // Regular paragraph line
    output.push(
      <div key={k++} style={{ lineHeight: "1.6", marginBottom: "1px" }}>
        {inlineFmt(line.trim())}
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
