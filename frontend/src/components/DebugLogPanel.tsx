import { useEffect, useState } from "react";
import { clearDebugLog, debugLogText, getLogEntries, type LogEntry, subscribeDebugLog } from "../lib/debuglog";

// A slide-up panel showing the intercepted console log + uncaught errors.
// Toggled from the top bar. Useful on mobile where devtools are hard to reach.
export function DebugLogPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>(() => [...getLogEntries()]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsub = subscribeDebugLog(() => setEntries([...getLogEntries()]));
    return () => {
      unsub();
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(debugLogText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older / permission-restricted browsers: fall back to a textarea selection
      const ta = document.createElement("textarea");
      ta.value = debugLogText();
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="debug-log-panel">
      <div className="debug-log-header">
        <span className="debug-log-title">Debug log ({entries.length})</span>
        <span className="top-bar-spacer" />
        <button type="button" className="debug-log-btn" onClick={copy}>
          {copied ? "copied" : "copy"}
        </button>
        <button type="button" className="debug-log-btn" onClick={clearDebugLog}>
          clear
        </button>
        <button type="button" className="debug-log-btn" onClick={onClose}>
          close
        </button>
      </div>
      <div className="debug-log-body">
        {entries.length === 0 ? (
          <div className="debug-log-empty">No log entries yet.</div>
        ) : (
          entries.map((e, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: ring-buffer append, order is stable
              key={i}
              className={`debug-log-line level-${e.level}`}
            >
              <span className="debug-log-time">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="debug-log-level">{e.level}</span>
              <span className="debug-log-text">{e.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
