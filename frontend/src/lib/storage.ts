// localStorage helpers with safe JSON parse

import { DEFAULT_FAVORITE_MODELS, DEFAULT_MODEL } from "./default_favorite_models";
import type { Repo, SelectedModel } from "./types";

const LS_LAST_REPO = "dancodes:lastRepo";
const LS_LAST_SESSION = "dancodes:lastSession"; // legacy global last-session (kept for migration)
const LS_LAST_SESSION_BY_REPO = "dancodes:lastSessionByRepo"; // preferred: per-repo last-session
const LS_LAST_MODEL = "dancodes:lastModel";
const LS_SESSION_DIRS = "dancodes:sessionDirs";
const LS_FAVORITES = "dancodes:favoriteModels";

function safeGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadLastRepo(): Repo | null {
  return safeGet<Repo>(LS_LAST_REPO);
}
export function saveLastRepo(repo: Repo) {
  safeSet(LS_LAST_REPO, repo);
}

// Legacy single global last-session. Kept as a fallback so we don't lose the
// user's place right after upgrade (before we've recorded a per-repo entry).
export function loadLastSession(): string | null {
  return safeGet<string>(LS_LAST_SESSION);
}
export function saveLastSession(id: string) {
  safeSet(LS_LAST_SESSION, id);
}

// Per-repo last-session: when switching between repos, restore the chat the user
// was last in for that repo (not just the globally-most-recent chat).
// Key is the repo full name (e.g. "owner/name").
export function loadLastSessionByRepo(repoName: string): string | null {
  const map = safeGet<Record<string, string>>(LS_LAST_SESSION_BY_REPO) ?? {};
  return map[repoName] ?? null;
}
export function saveLastSessionByRepo(repoName: string, sessionId: string) {
  const map = safeGet<Record<string, string>>(LS_LAST_SESSION_BY_REPO) ?? {};
  map[repoName] = sessionId;
  safeSet(LS_LAST_SESSION_BY_REPO, map);
}

export function loadLastModel(): SelectedModel {
  const saved = safeGet<SelectedModel>(LS_LAST_MODEL);
  if (saved) return saved;
  // Parse "provider/model" key into a SelectedModel
  const sep = DEFAULT_MODEL.indexOf("/");
  return { providerID: DEFAULT_MODEL.slice(0, sep), modelID: DEFAULT_MODEL.slice(sep + 1), name: "" };
}
export function saveLastModel(model: SelectedModel) {
  safeSet(LS_LAST_MODEL, model);
}

export function loadSessionDirs(): Record<string, string> {
  return safeGet<Record<string, string>>(LS_SESSION_DIRS) ?? {};
}
export function saveSessionDirs(dirs: Record<string, string>) {
  safeSet(LS_SESSION_DIRS, dirs);
}

export function loadFavorites(): string[] {
  return safeGet<string[]>(LS_FAVORITES) ?? DEFAULT_FAVORITE_MODELS;
}
export function saveFavorites(favs: string[]) {
  safeSet(LS_FAVORITES, favs);
}

export function modelKey(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`;
}
