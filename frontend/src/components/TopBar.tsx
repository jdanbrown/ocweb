import { ChevronLeft, Lock, RotateCw, ScrollText, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloneAndSelectRepo,
  closeSubagent,
  loadRepoPickerData,
  selectRepo,
  setDebugLogOpen,
  setSidebarOpen,
  useStore,
  viewedSessionId,
} from "../lib/store";
import type { Message } from "../lib/types";

// Tapping the top bar's "dead zones" (session label, spacer) scrolls chat to top,
// matching the iOS convention of tapping the status/title bar to scroll up.
// We dispatch a custom event that ChatView listens for.
export const SCROLL_TO_TOP_EVENT = "dancodes:scroll-to-top";

export function TopBar() {
  const { sidebarOpen, sessions, currentSessionId, viewStack, messages, debugLogOpen } = useStore();
  const topView = viewStack.at(-1);
  const inSubagentView = !!topView;

  // Session label: subagent title when viewing a subagent, else the root session's title
  const rootSession = sessions.find((s) => s.id === currentSessionId);
  const rootLabel = rootSession?.title || (currentSessionId ? currentSessionId.slice(0, 14) : null);
  const sessionLabel = topView ? topView.title : rootLabel;

  // Token total for the viewed session (sum of all step-finish tokens across all
  // assistant messages). We include cached-input as-is with input (that's what
  // LLM providers bill for from the user's perspective).
  const viewedId = viewedSessionId();
  const tokenInfo = viewedId ? summarizeTokens(messages[viewedId] ?? []) : null;

  // Scroll-to-top on tap of non-interactive top-bar areas
  const onTopBarClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Skip if the tap hit a button, link, picker, or other interactive element
    if (target.closest(".top-bar-btn, .top-bar-repo-picker, .env-toggle, button, a, input")) return;
    window.dispatchEvent(new Event(SCROLL_TO_TOP_EVENT));
  }, []);

  return (
    <div className="top-bar" onClick={onTopBarClick}>
      {inSubagentView ? (
        <span className="top-bar-btn" onClick={() => closeSubagent()}>
          <ChevronLeft size={18} />
        </span>
      ) : (
        <span className="top-bar-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
          &#9776;
        </span>
      )}
      <div className="top-bar-info">
        <RepoPickerInline />
        {sessionLabel && <div className="top-bar-session">{sessionLabel}</div>}
      </div>
      <span className="top-bar-spacer" />
      {tokenInfo && (
        <span className="top-bar-tokens" title={tokenInfo.title}>
          {tokenInfo.label}
        </span>
      )}
      <EnvToggle />
      <span className="top-bar-btn" title="Debug log" onClick={() => setDebugLogOpen(!debugLogOpen)}>
        <ScrollText size={14} />
      </span>
      <span className="top-bar-btn" onClick={() => window.location.reload()}>
        <RotateCw size={14} />
      </span>
    </div>
  );
}

function RepoPickerInline() {
  const { currentRepo, clonedRepos, githubRepos } = useStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      loadRepoPickerData();
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const clonedNames = clonedRepos.map((r) => r.name);
  let repos = githubRepos.map((r) => ({
    ...r,
    cloned: clonedNames.includes(r.full_name),
  }));
  if (query) {
    const q = query.toLowerCase();
    repos = repos.filter(
      (r) => r.full_name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
    );
  }

  function pick(fullName: string) {
    setOpen(false);
    const existing = clonedRepos.find((r) => r.name === fullName);
    if (existing) {
      selectRepo(existing);
    } else {
      cloneAndSelectRepo(fullName);
    }
  }

  const label = currentRepo ? currentRepo.name.split("/").pop() : "(Select repo...)";

  return (
    <div className="top-bar-repo-picker" ref={pickerRef}>
      <span className="top-bar-repo-label" onClick={() => setOpen(!open)}>
        {label}
      </span>
      {open && (
        <div className="top-bar-repo-dropdown">
          <div className="picker-search-wrap">
            <Search className="picker-search-icon" />
            <input ref={searchRef} className="picker-search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="picker-list">
            {repos.length === 0 && (
              <div className="picker-empty">{githubRepos.length === 0 && !query ? "Loading..." : "No repos found"}</div>
            )}
            {repos.map((r) => (
              <div
                key={r.full_name}
                className={`picker-item ${currentRepo?.name === r.full_name ? "active" : ""}`}
                onClick={() => pick(r.full_name)}
              >
                <span className="picker-item-name">{r.full_name.split("/").pop()}</span>
                {r.cloned && <span className="badge cloned">cloned</span>}
                {r.private && <Lock size={10} className="private-icon" />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Sum tokens across all step-finish parts in a session's assistant messages.
// Returns a compact human label (e.g. "12k") and a full breakdown for tooltip.
function summarizeTokens(msgs: Message[]): { label: string; title: string } | null {
  let inp = 0;
  let out = 0;
  let cached = 0;
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type !== "step-finish" || !p.tokens) continue;
      inp += p.tokens.input ?? 0;
      out += p.tokens.output ?? 0;
      cached += p.tokens.cache?.read ?? 0;
    }
  }
  const total = inp + out;
  if (total === 0) return null;
  return {
    label: `${compactTokens(total)} tok`,
    title: `${inp.toLocaleString()} in, ${out.toLocaleString()} out${cached ? `, ${cached.toLocaleString()} cached` : ""}`,
  };
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const PROD_URL = "https://dancodes.fly.dev/";
const DEV_URL = "http://dans-macbook-pro.local:8080/";

function EnvToggle() {
  const origin = `${window.location.origin}/`;
  const label = origin === PROD_URL ? "prod" : origin === DEV_URL ? "dev" : "unknown";
  const target = label === "prod" ? DEV_URL : PROD_URL;

  return (
    <span className="top-bar-btn env-toggle" onClick={() => window.location.assign(target)}>
      {label}
    </span>
  );
}
