import { useCallback, useEffect, useRef, useState } from "react";
import { dirFor, openSubagent, rejectQuestion, replyQuestion, useStore } from "../lib/store";
import type { Message, MessagePart, PendingQuestion, QuestionInfo } from "../lib/types";
import { SCROLL_TO_TOP_EVENT } from "./TopBar";

export function ChatView() {
  const { currentSessionId, currentRepo, messages, generating, streamingParts, viewStack } = useStore();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isAtBottom = useRef(true);

  // Which session to display: subagent if view stack nonempty, else root session
  const viewedId = viewStack.at(-1)?.sessionId ?? currentSessionId;
  const msgs = viewedId ? (messages[viewedId] ?? []) : [];
  const activeDelta = viewedId ? (streamingParts[viewedId] ?? {}) : {};

  // Track scroll position
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    isAtBottom.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  }, []);

  // Auto-scroll via a MutationObserver on the chat container.
  //
  // Why MutationObserver instead of `useEffect(..., [msgs, activeDelta])`:
  // The store mutates message arrays and parts in place (see store.ts handleEvent),
  // and `emit()` only shallow-copies the top-level state. So `messages[viewedId]`
  // keeps the same array reference across renders even as its contents grow,
  // and useEffect's Object.is dep check doesn't re-fire on appends/text deltas.
  // Observing DOM subtree changes directly is the robust signal: if content grew,
  // we tail. If the user scrolled away (isAtBottom=false), we don't.
  //
  // Use a callback ref so we (re)attach the observer whenever the container node
  // mounts/unmounts -- the early-return branches above render a different <div>
  // without the ref, so React swaps the node when content first appears.
  const setContainer = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    // Snap to bottom on initial attach (first content render)
    if (isAtBottom.current) el.scrollTop = el.scrollHeight;
    const mo = new MutationObserver(() => {
      if (isAtBottom.current) el.scrollTop = el.scrollHeight;
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    observerRef.current = mo;
  }, []);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  function scrollToBottom() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // Pressing the button means the user wants to re-enable auto-tail.
    // Without this, a prior scroll-up would have set isAtBottom=false, and the
    // next content arrival wouldn't tail until the user manually scrolled back.
    isAtBottom.current = true;
    setShowScrollBtn(false);
  }

  // Tap the top bar's dead zone to scroll chat to top (iOS convention)
  useEffect(() => {
    const handler = () => containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.addEventListener(SCROLL_TO_TOP_EVENT, handler);
    return () => window.removeEventListener(SCROLL_TO_TOP_EVENT, handler);
  }, []);

  if (!currentRepo) {
    return <div className="chat-view" />;
  }

  if (!viewedId) {
    return <div className="chat-view" />;
  }

  if (msgs.length === 0 && !generating[viewedId]) {
    return <div className="chat-view" />;
  }

  return (
    <div className="chat-view" ref={setContainer} onScroll={onScroll}>
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

// Tools that start collapsed -- output is noise for the user most of the time
const COLLAPSED_BY_DEFAULT = new Set(["read", "glob", "grep", "task"]);

function ToolPartView({ part }: { part: MessagePart }) {
  const defaultCollapsed = COLLAPSED_BY_DEFAULT.has(part.tool ?? "");
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const { pendingQuestions } = useStore();
  const st = part.state;
  if (!st) return null;

  const toolName = part.tool ?? "";
  const title = st.title ?? (toolName || "tool");
  const status = st.status;
  const command = toolName === "bash" ? (st.input?.command as string | undefined) : undefined;

  // For task tool parts, extract the subagent session id so we can render a
  // "view" affordance. opencode sets state.metadata.sessionId when the task tool
  // creates the subagent session (available during running and after completion).
  const subagentSessionId =
    toolName === "task" ? ((st.metadata?.sessionId as string | undefined) ?? undefined) : undefined;
  function onViewSubagent(e: React.MouseEvent) {
    e.stopPropagation(); // don't toggle collapse
    if (!subagentSessionId || !part.sessionID) return;
    const dir = dirFor(part.sessionID);
    if (!dir) return;
    openSubagent({ sessionId: subagentSessionId, directory: dir, title });
  }

  // Question tool: render an interactive prompt while awaiting answer.
  // Falls through to generic rendering once completed.
  if (toolName === "question" && (status === "pending" || status === "running")) {
    const pq = part.callID ? pendingQuestions[part.callID] : undefined;
    // Fallback to input.questions if pendingQuestions is empty (page load races, etc.)
    const questions = pq?.questions ?? (st.input?.questions as QuestionInfo[] | undefined) ?? [];
    return (
      <div className="msg-part tool question-pending">
        <div className="tool-title">{title}</div>
        <QuestionPrompt pq={pq} questions={questions} />
      </div>
    );
  }

  if (status === "pending" || status === "running") {
    return (
      <div className="msg-part tool running">
        {title} <span className="cursor" />
        {subagentSessionId && (
          <span className="subagent-view-link" onClick={onViewSubagent}>
            view &#8250;
          </span>
        )}
        {command && <div className="tool-command">$ {command}</div>}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="msg-part tool errored">
        <div className="tool-title">
          {title}
          {subagentSessionId && (
            <span className="subagent-view-link" onClick={onViewSubagent}>
              view &#8250;
            </span>
          )}
        </div>
        {command && <div className="tool-command">$ {command}</div>}
        <div className="tool-error">{st.error ?? "error"}</div>
      </div>
    );
  }

  // completed -- render body based on tool type
  const output = st.output ?? "";
  let body: React.ReactNode;
  if (toolName === "todowrite") {
    body = <TodoBody input={st.input} />;
  } else if (toolName === "edit") {
    body = <EditDiffBody input={st.input} />;
  } else if (toolName === "question") {
    body = <QuestionAnswered input={st.input} output={output} />;
  } else {
    body = (
      <>
        {command && <div className="tool-command">$ {command}</div>}
        {output && <div className="tool-output">{output}</div>}
      </>
    );
  }

  return (
    <div className="msg-part tool completed">
      <div className="tool-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="tool-title">{title}</span>
        {subagentSessionId && (
          <span className="subagent-view-link" onClick={onViewSubagent}>
            view &#8250;
          </span>
        )}
        <span className="tool-collapse-hint">{collapsed ? "show" : "hide"}</span>
      </div>
      {!collapsed && body}
    </div>
  );
}

// Render edit tool as a simple diff showing old → new
function EditDiffBody({ input }: { input?: Record<string, unknown> }) {
  const oldStr = (input?.oldString as string) ?? "";
  const newStr = (input?.newString as string) ?? "";
  if (!oldStr && !newStr) return null;
  return (
    <div className="edit-diff">
      {oldStr && (
        <div className="edit-diff-removed">
          {oldStr.split("\n").map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable id
            <div key={i} className="edit-diff-line">
              <span className="edit-diff-sign">-</span>
              {line}
            </div>
          ))}
        </div>
      )}
      {newStr && (
        <div className="edit-diff-added">
          {newStr.split("\n").map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable id
            <div key={i} className="edit-diff-line">
              <span className="edit-diff-sign">+</span>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Interactive prompt for a question tool call awaiting user reply.
// - Single question + single-select: tap an option to submit immediately.
// - Multi-select (multiple:true) or multiple questions: track local selections,
//   submit via a Send button.
// - Reject button dismisses all questions in the request.
function QuestionPrompt({ pq, questions }: { pq: PendingQuestion | undefined; questions: QuestionInfo[] }) {
  // selected[i] = array of labels chosen for question i
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));

  if (questions.length === 0) {
    return <div className="question-wait">Waiting for question details...</div>;
  }

  // If we don't have a requestID (pq not loaded yet), show read-only.
  // This is rare; it means the question.asked event hasn't arrived (or we missed it).
  if (!pq) {
    return (
      <div className="question-wait">
        <div className="question-wait-note">Loading question...</div>
        {questions.map((q, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: order matches backend
          <div key={i} className="question-block">
            <div className="question-text">{q.question}</div>
          </div>
        ))}
      </div>
    );
  }

  const singleQuestion = questions.length === 1;
  const onlyOne = singleQuestion && !questions[0].multiple;
  const callID = pq.callID;

  function toggle(qi: number, label: string, multiple: boolean) {
    setSelected((prev) => {
      const next = prev.map((a) => [...a]);
      const arr = next[qi];
      const idx = arr.indexOf(label);
      if (multiple) {
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(label);
      } else {
        next[qi] = idx >= 0 ? [] : [label];
      }
      return next;
    });
  }

  function submit(overrides?: string[][]) {
    const answers = overrides ?? selected;
    replyQuestion(callID, answers);
  }

  return (
    <div className="question-prompt">
      {questions.map((q, qi) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order is stable per request
        <div key={qi} className="question-block">
          <div className="question-text">{q.question}</div>
          <div className="question-options">
            {q.options.map((opt) => {
              const isSelected = selected[qi].includes(opt.label);
              const isImmediate = onlyOne; // tap-to-submit
              return (
                <div
                  key={opt.label}
                  className={`question-option ${isSelected ? "selected" : ""}`}
                  onClick={() => {
                    if (isImmediate) {
                      submit([[opt.label]]);
                    } else {
                      toggle(qi, opt.label, !!q.multiple);
                    }
                  }}
                >
                  <div className="question-option-label">{opt.label}</div>
                  {opt.description && <div className="question-option-description">{opt.description}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="question-actions">
        {!onlyOne && (
          <button
            type="button"
            className="question-send"
            onClick={() => submit()}
            disabled={selected.every((a) => a.length === 0)}
          >
            Send
          </button>
        )}
        <button type="button" className="question-dismiss" onClick={() => rejectQuestion(callID)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// Read-only view of a completed question tool call: show the questions and the answers.
function QuestionAnswered({ input, output }: { input?: Record<string, unknown>; output: string }) {
  const questions = (input?.questions as QuestionInfo[] | undefined) ?? [];
  // Try to parse answers from metadata is not available here; fall back to output text.
  // The completed tool state has `output = "User has answered your questions: "q1"="a1", ..."
  if (questions.length === 0) {
    return output ? <div className="tool-output">{output}</div> : null;
  }
  return (
    <div className="question-answered">
      {questions.map((q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order is stable
        <div key={i} className="question-block">
          <div className="question-text">{q.question}</div>
        </div>
      ))}
      {output && <div className="tool-output">{output}</div>}
    </div>
  );
}

// Render todo list as a formatted checklist instead of raw JSON
function TodoBody({ input }: { input?: Record<string, unknown> }) {
  const todos = input?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;

  const statusIcon = (s: string) => {
    if (s === "completed") return "\u2713";
    if (s === "in_progress") return "\u25B6";
    if (s === "cancelled") return "\u2013";
    return "\u25CB"; // pending
  };

  return (
    <div className="todo-list">
      {todos.map((t) => {
        const content = ((t as Record<string, unknown>).content as string) ?? "";
        const st = ((t as Record<string, unknown>).status as string) ?? "pending";
        return (
          <div key={content} className={`todo-item todo-${st}`}>
            <span className="todo-icon">{statusIcon(st)}</span>
            <span className="todo-content">{content}</span>
          </div>
        );
      })}
    </div>
  );
}
