"""
dancodes sidecar -- git lifecycle, disk usage, orphan process management, auth.
"""

import asyncio
import contextlib
import hashlib
import hmac
import logging
import os
import shutil
import subprocess
import time
import traceback
from collections.abc import AsyncIterator
from typing import Any, cast

import httpx
from fastapi import FastAPI, HTTPException, Request, Form
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel


class _LogFilterForUvicornAccess(logging.Filter):
    """Suppress access-log lines for auth checks (called on every request by Caddy forward_auth)"""

    def filter(self, record: logging.LogRecord) -> bool:
        return '"GET /auth/check ' not in record.getMessage()


logging.basicConfig(level=logging.INFO)
logging.getLogger("uvicorn.access").addFilter(_LogFilterForUvicornAccess())

logger = logging.getLogger(__name__)

PROJECTS_DIR = os.environ.get("DANCODES_PROJECTS_DIR", "/vol/projects")
GITHUB_USER = os.environ["GITHUB_USER"]
GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]

AUTH_PASSWORD = os.environ["AUTH_PASSWORD"]
AUTH_SECRET = os.environ["AUTH_SECRET"]
AUTH_MAX_AGE = 30 * 24 * 60 * 60  # 30 days
COOKIE_NAME = "dancodes_session"
# Fly terminates TLS at the edge, so the app sees HTTP -- but cookies need Secure
# for the browser to send them over HTTPS. Use X-Forwarded-Proto to detect.
COOKIE_SECURE = os.environ.get("FLY_APP_NAME", "") != ""

# Self-ping keepalive: while any opencode session is busy, ping our own public
# URL on a loop so Fly Proxy sees live connections and doesn't auto-stop the
# machine. Critical for async usage: user closes browser, agent keeps working.
# See MEMORY.md ([2026-03-13] on-demand machine) for the architectural context.
# `FLY_APP_NAME` is auto-set in prod; empty in local dev, which disables keepalive.
FLY_APP_NAME = os.environ.get("FLY_APP_NAME", "")
KEEPALIVE_URL = f"https://{FLY_APP_NAME}.fly.dev/admin/health" if FLY_APP_NAME else ""
KEEPALIVE_INTERVAL_SEC = 30  # Fly idle timeout is a few minutes; 30s has wide margin
# Safety cap on a single agent turn. If any in-progress assistant message has
# been running for this long, stop pinging so Fly auto-stops the machine. This
# catches runaway agents without affecting normal multi-turn chats -- each new
# turn starts with a fresh clock (measured via opencode's per-message timestamps).
KEEPALIVE_MAX_TURN_AGE_SEC = 2 * 60 * 60  # 2h


@contextlib.asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    task = asyncio.create_task(_keepalive_loop()) if KEEPALIVE_URL else None
    try:
        yield
    finally:
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


app = FastAPI(
    title="dancodes sidecar",
    docs_url="/admin/docs",
    openapi_url="/admin/openapi.json",
    lifespan=_lifespan,
)


@app.exception_handler(HTTPException)
async def _log_http_errors(request: Request, exc: HTTPException):  # pyright: ignore[reportUnusedFunction]
    if exc.status_code >= 500:
        logger.error(
            "%s %s -> %s: %s",
            request.method,
            request.url.path,
            exc.status_code,
            exc.detail,
        )
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(Exception)
async def _log_unhandled_errors(request: Request, exc: Exception):  # pyright: ignore[reportUnusedFunction]
    logger.error(
        "%s %s -> 500:\n%s", request.method, request.url.path, traceback.format_exc()
    )
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# --- Auth endpoints ---


def _sign_token(expires: int) -> str:
    payload = str(expires)
    sig = hmac.new(AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def _verify_token(token: str) -> bool:
    try:
        payload, sig = token.rsplit(".", 1)
        expected = hmac.new(
            AUTH_SECRET.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return False
        return int(payload) > time.time()
    except Exception:
        return False


@app.get("/auth/check")
def auth_check(request: Request) -> Response:
    """Caddy forward_auth calls this -- 200 means authenticated, otherwise redirect to login.
    forward_auth copies non-2xx responses directly to the client, so we redirect here."""
    token = request.cookies.get(COOKIE_NAME)
    if token and _verify_token(token):
        return Response(status_code=200)
    # forward_auth sends the original URI in X-Forwarded-Uri
    original = request.headers.get("X-Forwarded-Uri", "/")
    return RedirectResponse(url=f"/auth/login?redirect={original}", status_code=302)


@app.get("/auth/login", response_class=HTMLResponse)
def login_page(request: Request):
    error = request.query_params.get("error", "")
    redirect = request.query_params.get("redirect", "/")
    return f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>dancodes — login</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9;
         height: 100dvh; display: flex; align-items: center; justify-content: center; }}
  form {{ background: #161b22; border: 1px solid #30363d; border-radius: 12px;
          padding: 2rem; width: 300px; display: flex; flex-direction: column; gap: 1rem; }}
  h2 {{ font-size: 1.1rem; text-align: center; }}
  input {{ background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
           border-radius: 8px; padding: 0.7rem 0.875rem; font-size: 0.875rem;
           font-family: inherit; width: 100%; }}
  input:focus {{ outline: none; border-color: #58a6ff; }}
  button {{ background: #58a6ff; color: #fff; border: none; border-radius: 8px;
            padding: 0.7rem; font-size: 0.875rem; font-weight: 500; cursor: pointer; }}
  button:hover {{ opacity: 0.9; }}
  .error {{ color: #f85149; font-size: 0.8rem; text-align: center; }}
</style>
</head><body>
<form method="POST" action="/auth/login">
  <h2>dancodes</h2>
  {"<div class='error'>Wrong password</div>" if error else ""}
  <input type="password" name="password" placeholder="Password" autofocus>
  <input type="hidden" name="redirect" value="{redirect}">
  <button type="submit">Log in</button>
</form>
</body></html>"""


@app.post("/auth/login")
def login_submit(password: str = Form(...), redirect: str = Form("/")):
    if not redirect.startswith("/"):
        redirect = "/"
    if not AUTH_PASSWORD or password != AUTH_PASSWORD:
        return RedirectResponse(
            url=f"/auth/login?error=1&redirect={redirect}",
            status_code=303,
        )
    expires = int(time.time()) + AUTH_MAX_AGE
    token = _sign_token(expires)
    response = RedirectResponse(url=redirect, status_code=303)
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=AUTH_MAX_AGE,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return response


# --- Models (must precede endpoints -- FastAPI evaluates type annotations eagerly) ---


class CloneRequest(BaseModel):
    repo: str  # "owner/name"


class WorktreeRequest(BaseModel):
    repo: str
    session_id: str


# --- Repo endpoints ---


@app.get("/admin/repos/github")
async def list_github_repos() -> dict[str, list[dict[str, object]]]:
    """List repos the authenticated GitHub user has access to (owner + collaborator)."""
    repos: list[dict[str, object]] = []
    url: str | None = "https://api.github.com/user/repos?per_page=100&sort=pushed"
    async with httpx.AsyncClient() as client:
        while url:
            resp = await client.get(
                url,
                headers={
                    # "token" prefix works for both classic and fine-grained PATs
                    "Authorization": f"token {GITHUB_TOKEN}",
                    "Accept": "application/vnd.github+json",
                },
                timeout=15,
            )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"GitHub API returned {resp.status_code}: {resp.text[:200]}",
                )
            for r in resp.json():
                repos.append(
                    {
                        "full_name": r["full_name"],
                        "description": r.get("description") or "",
                        "private": r["private"],
                        "default_branch": r.get("default_branch", "main"),
                    }
                )
            url = _next_link(resp.headers.get("link", ""))
    return {"repos": repos}


def _next_link(link_header: str) -> str | None:
    """Parse GitHub Link header for rel=next URL."""
    for part in link_header.split(","):
        if 'rel="next"' in part:
            url = part.split(";")[0].strip().strip("<>")
            return url
    return None


@app.post("/admin/repos/clone")
def clone_repo(req: CloneRequest) -> dict[str, str]:
    dest = _repo_dir(req.repo)
    if os.path.exists(dest):
        return {"status": "exists", "path": dest}
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    result = _run(["git", "clone", _clone_url(req.repo), dest])
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr)
    # Set git author so LLM sessions can commit without manual config
    _run(["git", "config", "user.name", "dancodes"], cwd=dest)
    _run(["git", "config", "user.email", "dancodes@users.noreply.github.com"], cwd=dest)
    return {"status": "cloned", "path": dest}


@app.delete("/admin/repos/{owner}/{name}")
def delete_repo(owner: str, name: str) -> dict[str, str]:
    dest = _repo_dir(f"{owner}/{name}")
    if not os.path.exists(dest):
        raise HTTPException(status_code=404, detail="repo not found")
    shutil.rmtree(dest)
    return {"status": "deleted"}


@app.get("/admin/repos")
def list_repos() -> dict[str, list[dict[str, str]]]:
    repos_dir = os.path.join(PROJECTS_DIR, "repos")
    if not os.path.exists(repos_dir):
        return {"repos": []}
    entries = os.listdir(repos_dir)
    repos = [
        {"name": e.replace("__", "/", 1), "path": os.path.join(repos_dir, e)}
        for e in entries
        if os.path.isdir(os.path.join(repos_dir, e))
    ]
    return {"repos": repos}


# --- Worktree endpoints ---


@app.post("/admin/worktrees")
def create_worktree(req: WorktreeRequest) -> dict[str, str]:
    repo = _repo_dir(req.repo)
    if not os.path.exists(repo):
        raise HTTPException(status_code=404, detail="repo not cloned — clone it first")
    dest = _worktree_dir(req.repo, req.session_id)
    if os.path.exists(dest):
        return {"status": "exists", "path": dest}
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    # Fetch so worktree starts from latest remote state, not stale local main
    fetch = _run(["git", "fetch", "origin"], cwd=repo)
    if fetch.returncode != 0:
        raise HTTPException(status_code=500, detail=f"git fetch failed: {fetch.stderr}")
    branch_name = f"dancodes/{req.session_id}"
    result = _run(
        ["git", "worktree", "add", "-b", branch_name, dest, "origin/main"],
        cwd=repo,
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr)
    # Set upstream so `git push origin HEAD:main` is the natural push target,
    # and `git status` shows ahead/behind vs origin/main
    _run(["git", "config", f"branch.{branch_name}.remote", "origin"], cwd=dest)
    _run(["git", "config", f"branch.{branch_name}.merge", "refs/heads/main"], cwd=dest)
    return {"status": "created", "path": dest}


@app.delete("/admin/worktrees/{owner}/{name}/{session_id}")
def delete_worktree(owner: str, name: str, session_id: str) -> dict[str, str]:
    repo = _repo_dir(f"{owner}/{name}")
    dest = _worktree_dir(f"{owner}/{name}", session_id)
    if not os.path.exists(dest):
        raise HTTPException(status_code=404, detail="worktree not found")
    _run(["git", "worktree", "remove", "--force", dest], cwd=repo)
    if os.path.exists(dest):
        shutil.rmtree(dest)
    return {"status": "deleted"}


@app.get("/admin/worktrees")
def list_worktrees() -> dict[str, list[dict[str, str]]]:
    wt_dir = os.path.join(PROJECTS_DIR, "worktrees")
    if not os.path.exists(wt_dir):
        return {"worktrees": []}
    entries = os.listdir(wt_dir)
    worktrees: list[dict[str, str]] = []
    for e in entries:
        full = os.path.join(wt_dir, e)
        if os.path.isdir(full):
            parts = e.split("__", 2)
            worktrees.append(
                {
                    "repo": f"{parts[0]}/{parts[1]}" if len(parts) >= 2 else e,
                    "session_id": parts[2] if len(parts) >= 3 else "",
                    "path": full,
                }
            )
    return {"worktrees": worktrees}


# --- Disk & process endpoints ---


@app.get("/admin/disk")
def disk_usage() -> dict[str, str]:
    result = _run(["du", "-sh", PROJECTS_DIR])
    total = (
        result.stdout.strip().split("\t")[0] if result.returncode == 0 else "unknown"
    )
    stat = shutil.disk_usage("/vol")
    return {
        "projects_size": total,
        "volume_total": _human(stat.total),
        "volume_used": _human(stat.used),
        "volume_free": _human(stat.free),
    }


@app.get("/admin/processes")
def orphan_processes() -> dict[str, list[dict[str, str | int]]]:
    """Find processes whose parent is PID 1 (orphans), excluding known services."""
    known = {"caddy", "opencode", "uvicorn", "python3", "run"}
    result = _run(["ps", "-eo", "pid,ppid,comm,args", "--no-headers"])
    if result.returncode != 0:
        return {"orphans": []}
    orphans: list[dict[str, str | int]] = []
    for line in result.stdout.strip().splitlines():
        parts = line.split(None, 3)
        if len(parts) < 3:
            continue
        pid, ppid, comm = parts[0], parts[1], parts[2]
        args = parts[3] if len(parts) > 3 else ""
        if ppid == "1" and comm not in known:
            orphans.append({"pid": int(pid), "comm": comm, "args": args})
    return {"orphans": orphans}


@app.post("/admin/processes/{pid}/kill")
def kill_process(pid: int) -> dict[str, str | int]:
    try:
        os.kill(pid, 15)  # SIGTERM
    except ProcessLookupError:
        raise HTTPException(status_code=404, detail="process not found")
    except PermissionError:
        raise HTTPException(status_code=403, detail="permission denied")
    return {"status": "killed", "pid": pid}


@app.post("/admin/gc")
def garbage_collect() -> dict[str, int]:
    """Prune worktrees for repos, remove orphan worktree dirs."""
    repos_dir = os.path.join(PROJECTS_DIR, "repos")
    if not os.path.exists(repos_dir):
        return {"pruned": 0}
    pruned = 0
    for entry in os.listdir(repos_dir):
        repo = os.path.join(repos_dir, entry)
        if os.path.isdir(repo):
            result = _run(["git", "worktree", "prune"], cwd=repo)
            if result.returncode == 0:
                pruned += 1
    return {"pruned": pruned}


OPENCODE_URL = "http://localhost:4096"


@app.get("/admin/health")
async def health() -> dict[str, str]:
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{OPENCODE_URL}/global/health", timeout=2)
            resp.raise_for_status()
    except Exception:
        raise HTTPException(status_code=503, detail="opencode not ready")
    return {"status": "ok"}


# --- Helpers ---


def _repo_dir(repo: str) -> str:
    return os.path.join(PROJECTS_DIR, "repos", repo.replace("/", "__"))


def _worktree_dir(repo: str, session_id: str) -> str:
    return os.path.join(
        PROJECTS_DIR, "worktrees", f"{repo.replace('/', '__')}__{session_id}"
    )


def _clone_url(repo: str) -> str:
    return f"https://{GITHUB_USER}:{GITHUB_TOKEN}@github.com/{repo}.git"


def _run(cmd: list[str], cwd: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120, cwd=cwd)


def _human(nbytes: int) -> str:
    n = float(nbytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}PB"


# --- Keepalive loop ---


async def _oldest_running_turn_age_sec(client: httpx.AsyncClient) -> float | None:
    """Age (seconds) of the oldest currently-running agent turn across all sessions.

    An "agent turn" is an assistant message with `time.created` set but no
    `time.completed`. We enumerate every session in every worktree, look at its
    last assistant message, and if it's in-progress, track how long it's been running.
    Returns None if no turn is running (machine is effectively idle).

    We use per-turn wall-clock age (not sampled "busy streak") so that two
    back-to-back turns with a brief idle gap don't look like one long streak,
    and transient /session/status hiccups don't falsely reset the timer.
    """
    wt_dir = os.path.join(PROJECTS_DIR, "worktrees")
    if not os.path.exists(wt_dir):
        return None
    try:
        entries = os.listdir(wt_dir)
    except OSError:
        return None

    # Collect per-worktree list of busy session ids so we only fetch messages where needed
    busy_sessions: list[tuple[str, str]] = []  # (worktree_path, session_id)
    for entry in entries:
        path = os.path.join(wt_dir, entry)
        if not os.path.isdir(path):
            continue
        try:
            resp = await client.get(
                f"{OPENCODE_URL}/session/status",
                headers={"x-opencode-directory": path},
                timeout=5,
            )
            if resp.status_code != 200:
                continue
            data = resp.json()
            if not isinstance(data, dict):
                continue
            data_dict = cast(dict[str, Any], data)
            for sid, status in data_dict.items():
                if (
                    isinstance(status, dict)
                    and cast(dict[str, Any], status).get("type") != "idle"
                ):
                    busy_sessions.append((path, sid))
        except Exception:
            continue

    if not busy_sessions:
        return None

    now_ms = time.time() * 1000
    oldest_age_sec: float | None = None
    for path, sid in busy_sessions:
        try:
            resp = await client.get(
                f"{OPENCODE_URL}/session/{sid}/message",
                headers={"x-opencode-directory": path},
                timeout=5,
            )
            if resp.status_code != 200:
                continue
            msgs = resp.json()
            if not isinstance(msgs, list):
                continue
            msgs_list = cast(list[Any], msgs)
            # Find the most recent assistant message with no completion time.
            # Messages are chronological -- iterate in reverse.
            for m in reversed(msgs_list):
                if not isinstance(m, dict):
                    continue
                info = cast(dict[str, Any], m).get("info")
                if not isinstance(info, dict):
                    continue
                info_d = cast(dict[str, Any], info)
                if info_d.get("role") != "assistant":
                    continue
                t = info_d.get("time")
                if not isinstance(t, dict):
                    break
                t_d = cast(dict[str, Any], t)
                if t_d.get("completed") is not None:
                    # Latest assistant msg completed -- session shows busy but no
                    # in-flight turn (maybe a tool-call race). Skip this session.
                    break
                created = t_d.get("created")
                if isinstance(created, (int, float)):
                    age = (now_ms - created) / 1000
                    if oldest_age_sec is None or age > oldest_age_sec:
                        oldest_age_sec = age
                break
        except Exception:
            continue

    return oldest_age_sec


async def _keepalive_loop() -> None:
    """While any agent turn is running, ping our public URL so Fly keeps the machine alive.

    The public URL goes through Fly Proxy, which is what counts for auto-stop
    connection tracking. Internal (localhost, .internal) requests don't count.

    We only ping when a turn is running. When idle, we stay silent and let Fly
    auto-stop us.

    Safety cap: if any single turn runs longer than KEEPALIVE_MAX_TURN_AGE_SEC
    (currently 2h), we stop pinging so Fly idle-stops the machine. This catches
    runaway agents. We measure per-turn wall-clock age (via opencode message
    timestamps), so normal multi-turn chats don't trip the cap -- each new turn
    starts with a fresh clock, even if you chat for many hours.
    """
    logger.info(
        "keepalive: loop starting, target=%s, max_turn_age_sec=%s",
        KEEPALIVE_URL,
        KEEPALIVE_MAX_TURN_AGE_SEC,
    )
    async with httpx.AsyncClient() as client:
        while True:
            try:
                age = await _oldest_running_turn_age_sec(client)
                if age is None:
                    pass  # idle -- don't ping
                elif age > KEEPALIVE_MAX_TURN_AGE_SEC:
                    # Log once per minute rather than every iteration
                    if int(age) % 60 < KEEPALIVE_INTERVAL_SEC:
                        logger.warning(
                            "keepalive: oldest turn age %.0fs exceeds cap %ss, not pinging",
                            age,
                            KEEPALIVE_MAX_TURN_AGE_SEC,
                        )
                else:
                    try:
                        r = await client.get(KEEPALIVE_URL, timeout=10)
                        logger.debug(
                            "keepalive: pinged, status=%s, oldest_turn_age=%.0fs",
                            r.status_code,
                            age,
                        )
                    except Exception as e:
                        logger.warning("keepalive: ping failed: %s", e)
            except Exception:
                logger.exception("keepalive: unexpected error in loop")
            await asyncio.sleep(KEEPALIVE_INTERVAL_SEC)
