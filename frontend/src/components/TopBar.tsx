import { ChevronLeft, Lock, RotateCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  cloneAndSelectRepo,
  closeSubagent,
  loadRepoPickerData,
  selectRepo,
  setSidebarOpen,
  useStore,
} from "../lib/store";

export function TopBar() {
  const { sidebarOpen, sessions, currentSessionId, viewStack } = useStore();
  const topView = viewStack.at(-1);
  const inSubagentView = !!topView;

  // Session label: subagent title when viewing a subagent, else the root session's title
  const rootSession = sessions.find((s) => s.id === currentSessionId);
  const rootLabel = rootSession?.title || (currentSessionId ? currentSessionId.slice(0, 14) : null);
  const sessionLabel = topView ? topView.title : rootLabel;

  return (
    <div className="top-bar">
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
      <EnvToggle />
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
