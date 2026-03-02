import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import type { Message, MessagePart } from "../lib/types";

export function ChatView() {
  const { currentSessionId, currentRepo, messages, generating, streamingParts } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isAtBottom = useRef(true);

  const msgs = currentSessionId ? (messages[currentSessionId] ?? []) : [];
  const activeDelta = currentSessionId ? (streamingParts[currentSessionId] ?? {}) : {};

  // Track scroll position
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    isAtBottom.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  }, []);

  // Auto-scroll when new content arrives and we're at the bottom.
  // Intentionally triggers on msgs/activeDelta changes (not just refs).
  // biome-ignore lint/correctness/useExhaustiveDependencies: need to re-run on data changes
  useEffect(() => {
    if (isAtBottom.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [msgs, activeDelta]);

  function scrollToBottom() {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" });
  }

  if (!currentRepo) {
    return (
      <div className="chat-view">
        <div className="empty-state">
          <div className="empty-title">dancodes</div>
          <div className="empty-subtitle">Select a repo to get started</div>
        </div>
      </div>
    );
  }

  if (!currentSessionId) {
    return (
      <div className="chat-view">
        <div className="empty-state">
          <div className="empty-title">dancodes</div>
          <div className="empty-subtitle">Select a session or create a new one</div>
        </div>
      </div>
    );
  }

  if (msgs.length === 0 && !generating[currentSessionId]) {
    return <div className="chat-view" />;
  }

  return (
    <div className="chat-view" ref={containerRef} onScroll={onScroll}>
      {msgs.map((msg) => (
        <MessageBubble key={msg.info.id} msg={msg} activeDelta={activeDelta} />
      ))}
      {showScrollBtn && (
        <button className="scroll-to-bottom" onClick={scrollToBottom}>
          &#8595;
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function MessageBubble({ msg, activeDelta }: { msg: Message; activeDelta: Record<string, boolean> }) {
  const { info, parts } = msg;
  const role = info.role;

  if (role === "user") {
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    if (!text) return null;
    return (
      <div className="msg user">
        <div className="msg-role">user</div>
        <div className="msg-text">{text}</div>
      </div>
    );
  }

  if (role === "error") {
    const text = parts.map((p) => p.text ?? "").join("");
    return (
      <div className="msg error">
        <div className="msg-role">error</div>
        <div className="msg-text">{text}</div>
      </div>
    );
  }

  // Assistant
  const visibleParts = parts.filter(
    (p) => p.type === "text" || p.type === "reasoning" || p.type === "tool" || p.type === "step-finish",
  );
  if (visibleParts.length === 0) return null;

  const modelLabel = info.modelID ?? "";

  return (
    <div className="msg assistant">
      <div className="msg-role">
        assistant
        {modelLabel && <span className="msg-model">{modelLabel}</span>}
      </div>
      {visibleParts.map((p) => (
        <PartView key={p.id} part={p} streaming={!!activeDelta[p.id]} />
      ))}
    </div>
  );
}

function PartView({ part, streaming }: { part: MessagePart; streaming: boolean }) {
  const cursor = streaming ? <span className="cursor" /> : null;

  if (part.type === "text") {
    return (
      <div className="msg-part text">
        {part.text ?? ""}
        {cursor}
      </div>
    );
  }

  if (part.type === "reasoning") {
    return (
      <div className="msg-part reasoning">
        {part.text ?? ""}
        {cursor}
      </div>
    );
  }

  if (part.type === "tool") {
    return <ToolPartView part={part} />;
  }

  if (part.type === "step-finish" && part.tokens) {
    const inp = part.tokens.input ?? 0;
    const out = part.tokens.output ?? 0;
    const cached = part.tokens.cache?.read ?? 0;
    return (
      <div className="msg-part step-finish">
        {inp + out} tokens ({inp} in, {out} out{cached ? `, ${cached} cached` : ""})
      </div>
    );
  }

  return null;
}

function ToolPartView({ part }: { part: MessagePart }) {
  const [collapsed, setCollapsed] = useState(false);
  const st = part.state;
  if (!st) return null;

  const title = st.title ?? part.tool ?? "tool";
  const status = st.status;

  if (status === "pending" || status === "running") {
    return (
      <div className="msg-part tool running">
        {title} <span className="cursor" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="msg-part tool errored">
        <div className="tool-title">{title}</div>
        <div className="tool-error">{st.error ?? "error"}</div>
      </div>
    );
  }

  // completed
  const output = st.output ?? "";
  return (
    <div className="msg-part tool completed">
      <div className="tool-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="tool-title">{title}</span>
        <span className="tool-collapse-hint">{collapsed ? "show" : "hide"}</span>
      </div>
      {!collapsed && output && <div className="tool-output">{output}</div>}
    </div>
  );
}
