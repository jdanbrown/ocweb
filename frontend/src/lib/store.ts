// Global app state as a simple React-friendly store.
// Uses useSyncExternalStore for efficient subscriptions without Context re-render cascades.

import { nanoid } from "nanoid";
import { useSyncExternalStore } from "react";
import { del, get, post } from "./api";
import {
  loadFavorites,
  loadLastModel,
  loadLastRepo,
  loadLastSession,
  loadLastSessionByRepo,
  loadSessionDirs,
  modelKey,
  saveFavorites,
  saveLastModel,
  saveLastRepo,
  saveLastSession,
  saveLastSessionByRepo,
  saveSessionDirs,
} from "./storage";
import type {
  GithubRepo,
  Message,
  MessageInfo,
  MessagePart,
  PendingQuestion,
  Provider,
  QuestionInfo,
  Repo,
  SelectedModel,
  Session,
  SubagentView,
  Worktree,
} from "./types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface AppState {
  // Repo
  currentRepo: Repo | null;
  clonedRepos: Repo[];
  githubRepos: GithubRepo[];

  // Sessions
  sessions: Session[];
  currentSessionId: string | null;
  messages: Record<string, Message[]>;
  generating: Record<string, boolean>;
  // partId -> true for parts currently streaming
  streamingParts: Record<string, Record<string, boolean>>;

  // Worktrees
  allWorktrees: Worktree[];

  // Session directory mapping (persisted in localStorage)
  sessionDirs: Record<string, string>;

  // Model
  selectedModel: SelectedModel | null;
  providers: { id: string; name: string; models: { id: string; name: string }[] }[];
  connectedProviders: string[];

  // Pending question tool calls awaiting user reply.
  // Keyed by callID (unique per tool invocation), not requestID -- the tool part
  // carries callID but not requestID, so callID is what the UI can look up with.
  pendingQuestions: Record<string, PendingQuestion>;

  // Queued messages per session: prompts the user typed while an agent turn was
  // already running. Flushed (in order) as soon as the turn goes idle. Not
  // persisted -- if the user reloads mid-turn, the queue is lost (acceptable
  // tradeoff vs the complexity of surfacing queued state on reconnect).
  queuedMessages: Record<string, string[]>;

  // Subagent view stack: when a user taps a `task` tool call, we push the subagent's
  // session onto the stack and the UI shows that session instead of the root. Nested
  // subagents push further. Empty stack = viewing currentSessionId.
  viewStack: SubagentView[];

  // SSE
  sseStreams: Record<string, EventSource>;

  // UI
  sidebarOpen: boolean;
  debugLogOpen: boolean;
  version: { sha: string; time: string } | null;
  opencodeVersion: string | null;
}

const state: AppState = {
  currentRepo: null,
  clonedRepos: [],
  githubRepos: [],
  sessions: [],
  currentSessionId: null,
  messages: {},
  generating: {},
  streamingParts: {},
  allWorktrees: [],
  sessionDirs: loadSessionDirs(),
  selectedModel: null,
  providers: [],
  connectedProviders: [],
  pendingQuestions: {},
  queuedMessages: {},
  viewStack: [],
  sseStreams: {},
  sidebarOpen: false,
  debugLogOpen: false,
  version: null,
  opencodeVersion: null,
};

// ---------------------------------------------------------------------------
// Subscription (useSyncExternalStore)
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let snapshot = state;

function emit() {
  snapshot = { ...state };
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot() {
  return snapshot;
}

export function useStore(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// Direct access for non-React code (SSE handlers, etc.)
export function getState(): AppState {
  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function dirFor(sessionId: string): string | undefined {
  if (state.sessionDirs[sessionId]) return state.sessionDirs[sessionId];
  const s = state.sessions.find((s) => s.id === sessionId);
  if (s?.directory) return s.directory;
  // Subagent sessions aren't in `sessions` (filtered out of sidebar) or `sessionDirs`
  // (not persisted). When one is open via the view stack, read its directory from there.
  const v = state.viewStack.find((v) => v.sessionId === sessionId);
  return v?.directory;
}

// The currently-viewed session id: top of view stack if nonempty, else the root session.
// All user-facing UI (ChatView, InputArea Stop/Send, TopBar label) keys off this.
export function viewedSessionId(): string | null {
  return state.viewStack.at(-1)?.sessionId ?? state.currentSessionId;
}

function sessionUpdatedAt(s: Session): number {
  return s.time_updated ?? s.timeUpdated ?? 0;
}

export function sortedSessions(): Session[] {
  return [...state.sessions].sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a));
}

export function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

// "3:42 PM" for today, "Apr 20 15:42" for other days. Locale-aware.
// Used on individual chat messages to provide a sense of when things happened,
// without pinning to a specific timezone (local time).
export function formatMsgTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function setSidebarOpen(open: boolean) {
  state.sidebarOpen = open;
  emit();
}

export function setDebugLogOpen(open: boolean) {
  state.debugLogOpen = open;
  emit();
}

export async function selectRepo(repo: Repo) {
  state.currentRepo = repo;
  state.sessions = [];
  state.currentSessionId = null;
  state.viewStack = [];
  saveLastRepo(repo);
  emit();
  await loadSessions();
  if (state.sessions.length === 0) {
    await startNewSession();
  } else {
    // Restore the user's last-viewed session for this repo (falls back to most
    // recent if no per-repo entry exists or it's been deleted).
    const saved = loadLastSessionByRepo(repo.name);
    const sorted = sortedSessions();
    const resumeId = sorted.find((s) => s.id === saved)?.id ?? sorted[0]?.id;
    if (resumeId) await selectSession(resumeId);
  }
  syncSSE();
}

export async function loadWorktrees() {
  try {
    const wtData = await get("/admin/worktrees");
    state.allWorktrees = (wtData as { worktrees?: Worktree[] })?.worktrees ?? [];
    emit();
  } catch (e) {
    console.debug("loadWorktrees:", e);
  }
}

export async function loadSessions() {
  if (!state.currentRepo) return;
  try {
    const [sessionData, wtData] = await Promise.all([
      get("/session?roots=true", { directory: state.currentRepo.path }),
      get("/admin/worktrees"),
    ]);
    state.sessions = Array.isArray(sessionData)
      ? (sessionData as Session[])
      : ((sessionData as { sessions?: Session[] })?.sessions ?? []);
    state.allWorktrees = (wtData as { worktrees?: Worktree[] })?.worktrees ?? [];

    let dirsChanged = false;
    for (const s of state.sessions) {
      if (state.sessionDirs[s.id]) continue;
      if (s.directory) {
        state.sessionDirs[s.id] = s.directory;
        dirsChanged = true;
      }
    }
    if (dirsChanged) saveSessionDirs(state.sessionDirs);
    emit();
  } catch (e) {
    console.error("loadSessions:", e);
  }
}

export async function selectSession(id: string) {
  state.currentSessionId = id;
  state.sidebarOpen = false;
  state.viewStack = [];
  saveLastSession(id);
  if (state.currentRepo) saveLastSessionByRepo(state.currentRepo.name, id);
  emit();
  if (!state.messages[id]) {
    await fetchMessages(id);
  }
  const dir = dirFor(id);
  if (dir) loadPendingQuestions(dir);
}

async function ensureWorktree(sessionId: string): Promise<string | undefined> {
  const dir = dirFor(sessionId);
  if (!dir || !state.currentRepo) return dir;
  // Parse worktree path: /vol/projects/worktrees/owner__name__wtId
  const base = dir.split("/").pop();
  if (!base) return dir;
  const parts = base.split("__");
  if (parts.length < 3) return dir;
  const wtId = parts.slice(2).join("__");
  try {
    // Clone is idempotent (returns {status: "exists"} if already cloned)
    await post("/admin/repos/clone", { repo: state.currentRepo.name });
    // Create worktree is idempotent too
    await post("/admin/worktrees", { repo: state.currentRepo.name, session_id: wtId });
  } catch (e) {
    console.warn("ensureWorktree:", e);
  }
  return dir;
}

async function fetchMessages(id: string, dirOverride?: string) {
  // For subagent sessions, the caller passes the parent worktree dir directly;
  // skip ensureWorktree (it would parse `id` as a worktree name and fail to match).
  const dir = dirOverride ?? (await ensureWorktree(id));
  try {
    const data = await get(`/session/${id}/message`, { directory: dir });
    state.messages[id] = Array.isArray(data) ? (data as Message[]) : [];
  } catch (e) {
    console.error("fetchMessages:", e);
    state.messages[id] = [];
  }
  emit();
}

export async function sendPrompt(text: string) {
  const sid = state.currentSessionId;
  if (!sid || !text.trim()) return;

  // If the agent turn is already running, queue this prompt locally and flush
  // it when the turn completes. Preserves the Stop button (don't lose the
  // ability to abort) and avoids racing two prompts into opencode.
  if (state.generating[sid]) {
    if (!state.queuedMessages[sid]) state.queuedMessages[sid] = [];
    state.queuedMessages[sid].push(text);
    emit();
    return;
  }

  await _sendPromptNow(sid, text);
}

async function _sendPromptNow(sid: string, text: string) {
  // Optimistic user message
  if (!state.messages[sid]) state.messages[sid] = [];
  state.messages[sid].push({
    info: { id: `opt-${Date.now()}`, role: "user", sessionID: sid },
    parts: [{ id: `opt-part-${Date.now()}`, type: "text", text }],
  });
  emit();

  const dir = dirFor(sid);
  try {
    const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
    if (state.selectedModel) {
      body.model = { providerID: state.selectedModel.providerID, modelID: state.selectedModel.modelID };
    }
    await post(`/session/${sid}/prompt_async`, body, { directory: dir });
    state.generating[sid] = true;
    emit();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    alert(`Send failed: ${msg}`);
  }
}

// Flush any queued messages for a session once its turn goes idle. Called from
// the status-change paths (SSE session.status, session.error, initial poll).
// Fires one prompt; subsequent queued prompts fire as the new turn completes.
function flushQueuedMessages(sid: string) {
  const queue = state.queuedMessages[sid];
  if (!queue || queue.length === 0) return;
  const next = queue.shift();
  if (queue.length === 0) delete state.queuedMessages[sid];
  if (next) _sendPromptNow(sid, next);
}

export function removeQueuedMessage(sid: string, idx: number) {
  const queue = state.queuedMessages[sid];
  if (!queue) return;
  if (idx < 0 || idx >= queue.length) return;
  queue.splice(idx, 1);
  if (queue.length === 0) delete state.queuedMessages[sid];
  emit();
}

export async function abortSession() {
  // Abort whatever session is currently being viewed (subagent if stack is nonempty).
  const sid = viewedSessionId();
  if (!sid) return;
  const dir = dirFor(sid);
  try {
    await post(`/session/${sid}/abort`, undefined, { directory: dir });
  } catch (e) {
    console.warn("abort:", e);
  }
  state.generating[sid] = false;
  // Explicit stop -> discard queued prompts for the root session (not subagent).
  // Rationale: the user hit Stop to halt; auto-resuming with their queued text
  // would surprise them.
  const rootSid = state.currentSessionId;
  if (rootSid) delete state.queuedMessages[rootSid];
  emit();
}

export async function startNewSession(): Promise<string | null> {
  if (!state.currentRepo) return null;
  try {
    const wtId = nanoid(12);
    const wt = (await post("/admin/worktrees", {
      repo: state.currentRepo.name,
      session_id: wtId,
    })) as { path: string };

    const session = (await post("/session", undefined, { directory: wt.path })) as Session;
    state.sessionDirs[session.id] = wt.path;
    saveSessionDirs(state.sessionDirs);

    if (!state.sessions.find((x) => x.id === session.id)) {
      state.sessions.unshift(session);
    }
    state.currentSessionId = session.id;
    state.sidebarOpen = false;
    state.viewStack = [];
    saveLastSession(session.id);
    if (state.currentRepo) saveLastSessionByRepo(state.currentRepo.name, session.id);
    emit();
    syncSSE();
    return session.id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    alert(`Failed: ${msg}`);
    return null;
  }
}

export async function deleteSession(id: string) {
  const dir = dirFor(id);
  try {
    await del(`/session/${id}`, { directory: dir });
  } catch (e) {
    if (e instanceof Error && !e.message.startsWith("404")) {
      alert(`Failed: ${e.message}`);
      return;
    }
  }
  state.sessions = state.sessions.filter((s) => s.id !== id);
  delete state.messages[id];
  delete state.streamingParts[id];
  delete state.sessionDirs[id];
  saveSessionDirs(state.sessionDirs);
  if (state.currentSessionId === id) {
    state.currentSessionId = null;
    state.viewStack = [];
  }
  emit();
  syncSSE();
}

// --- Subagent view stack ---

// Open a subagent session in a view layered on top of the current session.
// Called when the user taps a `task` tool call. Idempotent: tapping the same
// subagent again (or a nested subagent) just pushes another entry.
export async function openSubagent(view: SubagentView) {
  state.viewStack.push(view);
  state.sidebarOpen = false;
  emit();
  if (!state.messages[view.sessionId]) {
    await fetchMessages(view.sessionId, view.directory);
  }
}

// Pop one level of the view stack (back-arrow / edge-swipe).
export function closeSubagent() {
  if (state.viewStack.length === 0) return;
  state.viewStack.pop();
  emit();
}

// --- Question tool (user-visible prompts from the assistant) ---

// Fetch pending questions for a directory and merge into state.
// Called on session select so reloads/new tabs see any outstanding questions.
async function loadPendingQuestions(dir: string) {
  try {
    const data = (await get("/question", { directory: dir })) as Array<{
      id: string;
      sessionID: string;
      questions: QuestionInfo[];
      tool?: { messageID: string; callID: string };
    }> | null;
    if (!Array.isArray(data)) return;
    let changed = false;
    for (const req of data) {
      if (!req.tool?.callID) continue; // only handle tool-originated questions
      const pq: PendingQuestion = {
        requestID: req.id,
        sessionID: req.sessionID,
        callID: req.tool.callID,
        questions: req.questions,
      };
      state.pendingQuestions[pq.callID] = pq;
      changed = true;
    }
    if (changed) emit();
  } catch (e) {
    console.debug("loadPendingQuestions:", e);
  }
}

// Answer a pending question. `answers` is one array per question in the request
// (each array is the selected labels, or custom-typed strings).
export async function replyQuestion(callID: string, answers: string[][]) {
  const pq = state.pendingQuestions[callID];
  if (!pq) return;
  const dir = dirFor(pq.sessionID);
  try {
    await post(`/question/${pq.requestID}/reply`, { answers }, { directory: dir });
    // Optimistic cleanup -- SSE `question.replied` will also clear this.
    delete state.pendingQuestions[callID];
    emit();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    alert(`Reply failed: ${msg}`);
  }
}

export async function rejectQuestion(callID: string) {
  const pq = state.pendingQuestions[callID];
  if (!pq) return;
  const dir = dirFor(pq.sessionID);
  try {
    await post(`/question/${pq.requestID}/reject`, undefined, { directory: dir });
    delete state.pendingQuestions[callID];
    emit();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    alert(`Reject failed: ${msg}`);
  }
}

// --- Repo management ---

export async function loadRepoPickerData() {
  try {
    const [ghData, clonedData] = await Promise.all([
      get("/admin/repos/github").catch((e) => {
        console.error("GitHub repos:", e);
        return null;
      }),
      get("/admin/repos"),
    ]);
    state.githubRepos = (ghData as { repos?: GithubRepo[] })?.repos ?? [];
    state.clonedRepos = (clonedData as { repos?: Repo[] })?.repos ?? [];
    emit();
  } catch (e) {
    console.error("loadRepoPickerData:", e);
  }
}

export async function cloneAndSelectRepo(fullName: string) {
  try {
    const result = (await post("/admin/repos/clone", { repo: fullName })) as { path: string };
    const repo = { name: fullName, path: result.path };
    state.clonedRepos.push(repo);
    emit();
    await selectRepo(repo);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    alert(`Clone failed: ${msg}`);
  }
}

export async function deleteRepo(owner: string, name: string) {
  await del(`/admin/repos/${owner}/${name}`);
  state.clonedRepos = state.clonedRepos.filter((r) => r.name !== `${owner}/${name}`);
  emit();
}

export async function deleteWorktree(owner: string, name: string, sessionId: string) {
  await del(`/admin/worktrees/${owner}/${name}/${sessionId}`);
  state.allWorktrees = state.allWorktrees.filter((w) => !(w.repo === `${owner}/${name}` && w.session_id === sessionId));
  emit();
}

// --- Model picker ---

export async function loadProviders() {
  try {
    const data = (await get("/provider")) as {
      all?: Provider[];
      connected?: string[];
      default?: Record<string, string>;
    };
    const all = data?.all ?? [];
    state.connectedProviders = data?.connected ?? [];
    const defaults = data?.default ?? {};

    state.providers = all
      .filter((p) => state.connectedProviders.includes(p.id))
      .map((p) => {
        const models = Object.values(p.models ?? {})
          .map((m) => ({ id: m.id, name: m.name ?? m.id }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { id: p.id, name: p.name ?? p.id, models };
      })
      .filter((p) => p.models.length > 0);

    if (!state.selectedModel && state.providers.length > 0) {
      const last = loadLastModel();
      if (last) {
        const p = state.providers.find((p) => p.id === last.providerID);
        const m = p?.models.find((m) => m.id === last.modelID);
        if (p && m) state.selectedModel = { providerID: p.id, modelID: m.id, name: m.name };
      }
      if (!state.selectedModel) {
        for (const p of state.providers) {
          const defModelId = defaults[p.id];
          if (defModelId) {
            const m = p.models.find((m) => m.id === defModelId);
            if (m) {
              state.selectedModel = { providerID: p.id, modelID: m.id, name: m.name };
              break;
            }
          }
        }
      }
      if (!state.selectedModel) {
        const p = state.providers[0];
        const m = p.models[0];
        state.selectedModel = { providerID: p.id, modelID: m.id, name: m.name };
      }
    }
    emit();
  } catch (e) {
    console.error("loadProviders:", e);
  }
}

export function pickModel(providerID: string, modelID: string, name: string) {
  state.selectedModel = { providerID, modelID, name };
  saveLastModel(state.selectedModel);
  emit();
}

export function toggleFavorite(providerID: string, modelID: string) {
  const key = modelKey(providerID, modelID);
  const favs = loadFavorites();
  const idx = favs.indexOf(key);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(key);
  saveFavorites(favs);
  // No state change needed -- component re-reads from localStorage
}

// --- Version ---

export async function loadVersion() {
  try {
    const r = await fetch("/version.json");
    const v = (await r.json()) as { sha: string; time: string };
    state.version = { sha: v.sha, time: v.time };
    emit();
  } catch {
    // ignore
  }
  try {
    const r = await fetch("/global/health");
    const v = (await r.json()) as { healthy: boolean; version: string };
    state.opencodeVersion = v.version;
    emit();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// SSE -- one stream per recently-active worktree directory
// ---------------------------------------------------------------------------

const SSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function syncSSE() {
  const now = Date.now();
  const needed = new Set<string>();
  for (const s of state.sessions) {
    const dir = dirFor(s.id);
    if (!dir) continue;
    const updated = sessionUpdatedAt(s);
    if (updated === 0 || now - updated < SSE_MAX_AGE_MS) {
      needed.add(dir);
    }
  }

  for (const dir of Object.keys(state.sseStreams)) {
    if (!needed.has(dir)) {
      console.log(`SSE: closing stream for ${dir}`);
      state.sseStreams[dir].close();
      delete state.sseStreams[dir];
    }
  }

  for (const dir of needed) {
    if (!state.sseStreams[dir]) {
      connectSSEForDir(dir);
      pollSessionStatus(dir);
    }
  }
  emit();
}

// Tracks "have we opened successfully at least once?" per stream.
// Used so the FIRST onopen is a silent initial connect, and every onopen after
// that is a reconnect that triggers a re-sync (refetch messages + poll status
// + reload pending questions). SSE events that happened while we were
// disconnected are simply dropped by the server, so we have to catch up via
// REST to avoid the UI falling behind.
const sseEverConnected = new Set<string>();

function connectSSEForDir(dir: string) {
  const url = `/event?directory=${encodeURIComponent(dir)}`;
  console.log(`SSE: connecting for ${dir}`);
  const es = new EventSource(url);
  state.sseStreams[dir] = es;
  es.onopen = () => {
    if (sseEverConnected.has(dir)) {
      console.log(`SSE: reconnected for ${dir}, resyncing`);
      resyncDir(dir);
    } else {
      sseEverConnected.add(dir);
    }
    emit();
  };
  es.onerror = () => emit();
  es.onmessage = (ev) => handleEvent(ev.data);
}

// Full re-sync for a directory: pull fresh session status, refetch messages for
// any loaded sessions in this dir, and reload pending questions. Called on SSE
// reconnect and on page visibility return.
async function resyncDir(dir: string) {
  try {
    await pollSessionStatus(dir);
    const sessionsInDir = state.sessions.filter((s) => dirFor(s.id) === dir);
    for (const s of sessionsInDir) {
      if (state.messages[s.id]) {
        await fetchMessages(s.id, dir);
      }
    }
    await loadPendingQuestions(dir);
  } catch (e) {
    console.warn(`resyncDir(${dir}):`, e);
  }
}

// Refresh everything when the tab becomes visible after being hidden.
// (Browsers throttle SSE aggressively on background tabs; on iOS/Safari the
// connection can be silently dropped without an error event.)
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    console.log("visibilitychange: visible -> resync all dirs");
    for (const dir of Object.keys(state.sseStreams)) resyncDir(dir);
    // Refresh git stats; cheap one-shot REST call, avoids stale dirty indicators
    // if the user (or an agent) changed files while the tab was hidden.
    loadWorktrees();
  });
}

async function pollSessionStatus(dir: string) {
  try {
    const data = (await get("/session/status", { directory: dir })) as Record<string, { type: string }> | null;
    if (!data) return;
    for (const [sid, status] of Object.entries(data)) {
      state.generating[sid] = status.type !== "idle";
    }
    emit();
  } catch (e) {
    console.debug("pollSessionStatus:", e);
  }
}

function handleEvent(raw: string) {
  let ev: { type?: string; properties?: Record<string, unknown> };
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  if (!ev) return;

  const type = ev.type ?? "";
  const props = ev.properties ?? {};
  if (type === "server.heartbeat" || type === "server.connected") return;
  console.debug("SSE:", type, props);

  // Session events
  if (type === "session.created" || type === "session.updated") {
    const info = props.info as Session | undefined;
    if (info) {
      const idx = state.sessions.findIndex((s) => s.id === info.id);
      if (idx >= 0) state.sessions[idx] = info;
      else if (type === "session.created" && !info.parentID) state.sessions.unshift(info);
      emit();
    }
  }

  if (type === "session.status") {
    const sid = props.sessionID as string | undefined;
    const statusType = (props.status as { type?: string })?.type;
    if (sid && statusType) {
      const wasBusy = !!state.generating[sid];
      state.generating[sid] = statusType !== "idle";
      emit();
      // Turn went idle -> flush any queued prompts for this session
      if (wasBusy && statusType === "idle") {
        flushQueuedMessages(sid);
        // Agent turn likely changed files -- refresh git stats so sidebar/topbar
        // reflect dirty state without waiting for the next full reload.
        loadWorktrees();
      }
    }
  }

  if (type === "session.error") {
    const sid = props.sessionID as string | undefined;
    if (sid) {
      state.generating[sid] = false;
      // Error ends the turn -- flush queued prompts (user can Stop/remove them
      // individually if they want to cancel follow-ups)
      flushQueuedMessages(sid);
      emit();
    }
  }

  // Message events
  if (type === "message.updated") {
    const info = props.info as MessageInfo | undefined;
    if (!info) return;
    const sid = info.sessionID;
    if (!sid || !state.messages[sid]) return;
    const list = state.messages[sid];
    if (info.role === "user") {
      const optIdx = list.findIndex((m) => m.info.id.startsWith("opt-"));
      if (optIdx >= 0) list.splice(optIdx, 1);
    }
    const idx = list.findIndex((m) => m.info.id === info.id);
    if (idx >= 0) {
      list[idx].info = info;
    } else {
      list.push({ info, parts: [] });
    }
    if (info.role === "assistant" && info.error) {
      const err = info.error;
      const errMsg = err.data?.message ?? err.message ?? err.name ?? "Unknown error";
      const errId = `err-${info.id}`;
      if (!list.find((m) => m.info.id === errId)) {
        list.push({
          info: { id: errId, role: "error", sessionID: sid },
          parts: [{ id: `err-part-${info.id}`, type: "text", text: errMsg }],
        });
      }
    }
    emit();
  }

  if (type === "message.part.updated") {
    const part = props.part as MessagePart | undefined;
    if (!part) return;
    const sid = part.sessionID;
    const msgId = part.messageID;
    if (!sid || !state.messages[sid]) return;
    const msg = state.messages[sid].find((m) => m.info.id === msgId);
    if (!msg) return;
    const idx = msg.parts.findIndex((p) => p.id === part.id);
    if (idx >= 0) msg.parts[idx] = part;
    else msg.parts.push(part);
    emit();
  }

  // Question events
  if (type === "question.asked") {
    const req = props as {
      id?: string;
      sessionID?: string;
      questions?: QuestionInfo[];
      tool?: { messageID?: string; callID?: string };
    };
    if (req.id && req.sessionID && req.questions && req.tool?.callID) {
      state.pendingQuestions[req.tool.callID] = {
        requestID: req.id,
        sessionID: req.sessionID,
        callID: req.tool.callID,
        questions: req.questions,
      };
      emit();
    }
  }

  if (type === "question.replied" || type === "question.rejected") {
    const { requestID } = props as { requestID?: string };
    if (requestID) {
      const callID = Object.keys(state.pendingQuestions).find(
        (cid) => state.pendingQuestions[cid].requestID === requestID,
      );
      if (callID) {
        delete state.pendingQuestions[callID];
        emit();
      }
    }
  }

  if (type === "message.part.delta") {
    const { sessionID, messageID, partID, field, delta } = props as {
      sessionID?: string;
      messageID?: string;
      partID?: string;
      field?: string;
      delta?: string;
    };
    if (!sessionID || !state.messages[sessionID]) return;
    const msg = state.messages[sessionID].find((m) => m.info.id === messageID);
    if (msg) {
      const part = msg.parts.find((p) => p.id === partID);
      if (part && field === "text") {
        part.text = (part.text ?? "") + delta;
      }
    }
    if (partID) {
      if (!state.streamingParts[sessionID]) state.streamingParts[sessionID] = {};
      state.streamingParts[sessionID][partID] = true;
      // Clear streaming flag on next frame
      requestAnimationFrame(() => {
        if (state.streamingParts[sessionID]) {
          delete state.streamingParts[sessionID][partID];
        }
      });
    }
    emit();
  }
}

// ---------------------------------------------------------------------------
// Init -- call once on app mount
// ---------------------------------------------------------------------------

export async function initApp() {
  loadVersion();
  loadProviders();

  // Always fetch cloned repos so the picker is populated
  try {
    const data = (await get("/admin/repos")) as { repos?: Repo[] };
    state.clonedRepos = data?.repos ?? [];
  } catch (e) {
    console.warn("initApp: failed to load repos:", e);
  }

  // Pick repo: saved repo if still cloned, else auto-select if only one
  const savedRepo = loadLastRepo();
  if (savedRepo && state.clonedRepos.find((r) => r.name === savedRepo.name)) {
    state.currentRepo = savedRepo;
  } else if (state.clonedRepos.length === 1) {
    state.currentRepo = state.clonedRepos[0];
    saveLastRepo(state.clonedRepos[0]);
  }
  emit();

  if (state.currentRepo) {
    try {
      await loadSessions();
      // Prefer per-repo last-session; fall back to legacy global last-session for migration
      const savedSession = loadLastSessionByRepo(state.currentRepo.name) ?? loadLastSession();
      const sorted = sortedSessions();
      const resumeId = sorted.find((s) => s.id === savedSession)?.id ?? sorted[0]?.id;
      if (resumeId) {
        await selectSession(resumeId);
      } else {
        await startNewSession();
      }
    } catch (e) {
      console.warn("initApp: failed to load sessions:", e);
    }
    syncSSE();
  }
  emit();
}
