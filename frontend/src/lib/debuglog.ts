// Frontend debug log: intercept console.* and keep a ring buffer.
//
// Purpose: on mobile we can't open devtools, but we need a way to diagnose
// errors and trace behavior. The debug log panel (toggled from the top bar)
// shows the tail of this buffer and lets the user copy the whole thing.
//
// Mount-once semantics: main.tsx calls installDebugLog() before React mounts.
// We preserve the original console methods so regular browser devtools still
// receive output when they are available.

export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface LogEntry {
  ts: number; // ms since epoch
  level: LogLevel;
  text: string;
}

const MAX_ENTRIES = 500;

const entries: LogEntry[] = [];
const listeners = new Set<() => void>();

let installed = false;

function emit() {
  for (const fn of listeners) fn();
}

export function installDebugLog() {
  if (installed) return;
  installed = true;
  const levels: LogLevel[] = ["log", "info", "warn", "error", "debug"];
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        entries.push({ ts: Date.now(), level, text: fmt(args) });
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
        emit();
      } catch {
        // never let logging crash the app
      }
      orig(...args);
    };
  }
  // Also catch uncaught errors + unhandled promise rejections
  window.addEventListener("error", (e) => {
    entries.push({ ts: Date.now(), level: "error", text: `[uncaught] ${e.message} @ ${e.filename}:${e.lineno}` });
    emit();
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    entries.push({
      ts: Date.now(),
      level: "error",
      text: `[unhandledrejection] ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
    });
    emit();
  });
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export function getLogEntries(): LogEntry[] {
  return entries;
}

export function subscribeDebugLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearDebugLog() {
  entries.length = 0;
  emit();
}

export function debugLogText(): string {
  return entries
    .map((e) => {
      const d = new Date(e.ts);
      return `${d.toISOString()} [${e.level.toUpperCase()}] ${e.text}`;
    })
    .join("\n");
}
