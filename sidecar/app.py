"""
dancodes sidecar -- git lifecycle, disk usage, orphan process management, auth.
"""

import hashlib
import hmac
import logging
import os
import shutil
import subprocess
import time
import traceback

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

app = FastAPI(
    title="dancodes sidecar", docs_url="/admin/docs", openapi_url="/admin/openapi.json"
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
