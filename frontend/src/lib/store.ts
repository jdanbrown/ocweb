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
  loadSessionDirs,
  modelKey,
  saveFavorites,
  saveLastModel,
  saveLastRepo,
  saveLastSession,
  saveSessionDirs,
} from "./storage";
import type {
  GithubRepo,
  Message,
  MessageInfo,
  MessagePart,
  Provider,
  Repo,
  SelectedModel,
  Session,
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

  // SSE
  sseStreams: Record<string, EventSource>;

  // UI
  sidebarOpen: boolean;
  version: string | null;
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
  sseStreams: {},
  sidebarOpen: false,
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
  return s?.directory;
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

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function setSidebarOpen(open: boolean) {
  state.sidebarOpen = open;
  emit();
}

export async function selectRepo(repo: Repo) {
  state.currentRepo = repo;
  state.sessions = [];
  state.currentSessionId = null;
  saveLastRepo(repo);
  emit();
  await loadSessions();
  if (state.sessions.length === 0) {
    await startNewSession();
  }
  syncSSE();
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
  saveLastSession(id);
  emit();
  if (!state.messages[id]) {
    await fetchMessages(id);
  }
}

async function fetchMessages(id: string) {
  const dir = dirFor(id);
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

export async function abortSession() {
  const sid = state.currentSessionId;
  if (!sid) return;
  const dir = dirFor(sid);
  try {
    await post(`/session/${sid}/abort`, undefined, { directory: dir });
  } catch (e) {
    console.warn("abort:", e);
  }
  state.generating[sid] = false;
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
  }
  emit();
  syncSSE();
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
    state.version = `${v.sha} (${v.time})`;
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

function connectSSEForDir(dir: string) {
  const url = `/event?directory=${encodeURIComponent(dir)}`;
  console.log(`SSE: connecting for ${dir}`);
  const es = new EventSource(url);
  state.sseStreams[dir] = es;
  es.onopen = () => emit();
  es.onerror = () => emit();
  es.onmessage = (ev) => handleEvent(ev.data);
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
      state.generating[sid] = statusType !== "idle";
      emit();
    }
  }

  if (type === "session.error") {
    const sid = props.sessionID as string | undefined;
    if (sid) {
      state.generating[sid] = false;
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
      const savedSession = loadLastSession();
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
