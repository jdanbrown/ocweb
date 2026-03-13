# dancodes
Personal service like claude code web, using opencode, with a mobile frontend
- [`README.md`](README.md) -- purpose and design (this doc)
- [`AGENTS.md`](AGENTS.md) -- working model for llms
- [`MEMORY.md`](MEMORY.md) -- institutional memory for llms
- [`BACKLOG.md`](BACKLOG.md) -- backlog of ideas for the future

## Motivation
- The mobile/async UX of Claude Code Web is great (fire-and-forget from phone)
- But: usage limits, flakiness, slowness on the $20/mo plan
- Opencode + openrouter on laptop is already great -- let's extend it to mobile

## Architecture
```
Phone → Caddy (TLS + cookie auth) → opencode serve :4096
                                        ↓
                                    /vol/projects/  (git clones + worktrees)
                                    /vol/opencode-state/  (SQLite)
```

Plus a small **sidecar** for git lifecycle + resource management.

### Why this is so thin
A single `opencode serve` process already handles:
- Multiple projects natively (via `directory` query param / `x-opencode-directory` header)
- Full REST + SSE API (sessions, prompts, streaming, abort, fork, diff, health)
- Session persistence in SQLite (survives restarts)
- OpenAPI spec auto-generated from Zod schemas

So the frontend can talk to the opencode API directly. No orchestrator/proxy needed.

### How opencode directory scoping works
Opencode's directory model is **per-request**, not per-session. Every request goes through middleware
that resolves the directory from: `?directory=` query param → `x-opencode-directory` header → `process.cwd()`.
This determines the Instance context (project, git worktree, tool CWD, etc.) for that request.

Key implications for our multi-worktree design:
- **Every API call to opencode must include `x-opencode-directory`** with the session's worktree path.
  The directory is NOT stored on the session and recalled automatically -- it's resolved fresh per request.
- **SSE (`/event`) is scoped to one directory** -- events are published on instance-scoped buses, so an SSE
  connection for directory A only receives events for sessions in directory A. To juggle multiple concurrent
  chats across different worktrees, the frontend must maintain **one SSE stream per worktree directory**.
- **Session listing (`GET /session`) returns all sessions for the project** (identified by git root commit SHA).
  All worktrees of the same repo share the same project, so sessions from any worktree are visible from any
  other worktree of the same repo. The `directory` query param is an optional additional filter.
- **Session creation (`POST /session`)** does NOT accept `directory` in the JSON body -- the directory comes
  entirely from the middleware (header/query param). Passing `{ directory: path }` in the body is silently ignored.

### Auth: cookie-based via Caddy forward_auth
- Caddy uses `forward_auth` to check a session cookie on every request (except health check + auth endpoints)
- Sidecar handles auth: login page (`GET /auth/login`), form submit (`POST /auth/login`), cookie check (`GET /auth/check`)
- Cookie is HMAC-signed with `AUTH_SECRET`, expires after 30 days
- `OPENCODE_SERVER_PASSWORD` left **unset** on opencode serve -- Caddy + sidecar are the auth wall
- Rationale: cookie auth avoids constant re-prompting (unlike basic auth), works uniformly across all routes

### Deploys: no drain needed
- Opencode sessions persist in SQLite, survive restarts
- Truncated llm responses recovered by prompting "keep going"
- Fly replaces the whole VM on deploy, so orphaned child procs die with it
- Not worth engineering graceful drain for personal use

## Sidecar
A small service for things opencode doesn't expose.

### Git management
- GitHub username hardcoded in fly.toml, API token injected via secrets
- **Clone**: regular (non-bare) clone on first use -- needed so opencode can use the repo dir to list sessions
- **Worktree per session**: each chat gets a git worktree keyed by opencode session ID
- On new chat: clone if needed → create worktree → tell opencode to work in that dir

### Resource management
- Cloned repos: list, delete
- Worktrees / session dirs: list, delete
- Disk usage (volume stats)
- Orphan process detection (`ps` for PPID=1, filter known services) + kill
- Garbage collection (prune stale worktrees)

### Not yet implemented
- List user's repos via GitHub API (currently must specify `owner/name` manually)
- Frontend resource dashboard UI (endpoints exist, no UI yet)
- Running opencode sessions in the resource view (query opencode API from frontend)

### Sidecar API
```
POST   /admin/repos/clone                          {repo: "owner/name"}
DELETE /admin/repos/{owner}/{name}
GET    /admin/repos

POST   /admin/worktrees                            {repo, session_id, branch?}
DELETE /admin/worktrees/{owner}/{name}/{session_id}
GET    /admin/worktrees

GET    /admin/disk
POST   /admin/gc
GET    /admin/processes                             (orphan detection)
POST   /admin/processes/{pid}/kill
GET    /admin/health
```

Auto-generated OpenAPI docs at `/admin/docs`.

### Process cleanup notes
- Always use the opencode API to stop sessions (`POST /session/:id/abort`, `POST /instance/dispose`), never raw `kill`
- Session abort triggers `Shell.killTree()` → process-group-level SIGTERM → SIGKILL (clean)
- If opencode serve itself is killed, child procs may orphan (spawned with `detached: true`, no signal handlers in headless mode)
- On Fly this is fine since deploys replace the VM

## Hosting: Fly.io
- 1 machine (`performance-8x`, 16GB RAM) + 1 volume (10GB)
- `auto_stop_machines = "stop"` with `min_machines_running = 0` -- machine stops when idle (no connections), restarts on next request
  - Billed per-second only while running. Stopped machine costs only rootfs + volume storage (~$2/mo idle)
  - Cold start: ~300ms VM boot + ~20s app startup (opencode SQLite migration, etc.)
  - SSE connections keep the machine alive while browser tab is open
  - If machine stops mid-LLM-task, session is persisted in SQLite -- prompt "keep going" to resume
- Volume is single-attach, pinned to host -- machine always restarts on the same host where the volume lives
- Health check: `/admin/health` (sidecar) checks opencode liveness, unauthenticated in Caddy
  - No ongoing Fly health checks (too noisy for personal use)
  - `fly deploy` exits before the app is fully ready (~20s startup); rely on manual verification

### Volume durability
- Fly volumes can lose in-flight writes during VM migrations (deploys, size changes, host maintenance)
- Git is especially vulnerable -- it doesn't fsync by default, trusting `rename()` atomicity, which doesn't work when the storage layer drops buffered data
- Fix: `core.fsync=all` in the Dockerfile forces git to fsync every write
- See MEMORY.md for full analysis and alternatives considered

## Frontend

### Strategy: web first, iOS-native later (or never)
- Web frontend first because llm coding tools close the loop on web easily
- iOS native second (or never), once the API and backend are proven
- Even if web frontend is throwaway, it smooths out API/backend issues

### Custom frontend
- Mobile-first responsive web app (React + Vite + TypeScript)
- Talks to opencode REST + SSE API at `/` (same origin, no prefix)
- Talks to sidecar API for git/resource management at `/admin/*`
- **Concurrent chats**: fire off multiple chats, monitor progress from the sidebar (status, activity), dive into any chat to see details -- all from one tab
- Concurrency: multiple tabs/reconnects → broadcast pattern, last-write-wins on input

### Frontend design
- Mobile-first -- opencode CLI is the UX grounding, adapted to a mobile flow
- "Pick repo" → "pick/create chat session" is top-level in the UX, persisted client-side
- On page load, drop the user into a focused text box: restore last-used repo, pick most recent chat. Only exception: no last-used repo and no repos on disk -- don't auto-clone anything. Show a "+" button in the top right so it's easy to create a new chat if the restored one isn't what they want
- Sidebar is a key UX component: swipe gestures to show/hide (in addition to buttons/taps)
- No zoom on mobile -- focusing inputs must not zoom the page
- Input area groups: send/stop button, model picker, opencode mode picker (build/plan/etc), upload photo
- "Scroll to bottom" button when scrolled up in chat; auto-follow new content when scroll is at the bottom (standard chat app idiom)
- Three-dots menu (upper right) for misc actions: copy branch (with branch name inline), share session, rename session, show git stat/diff
- Messages are left-aligned like opencode CLI (not alternating left/right like SMS)
- Large model output chunks (tool output, code diffs) shown in full by default, with option to tap-collapse. Don't hide info by default.
- Top bar: version string, link to opencode web. No liveness dots.
- Style: pure black (#000) background, shades of gray for contrast. Consolas monospace font everywhere.

## Implementation notes

### Container layout
Single Dockerfile, all files under `/opt/dancodes/`. Three processes managed by `run`:
1. **opencode serve** on `:4096` (`--hostname 0.0.0.0`, `OPENCODE_SERVER_PASSWORD` unset)
2. **Sidecar** (Python/FastAPI/uvicorn) on `:4097`
3. **Caddy** on `:8080` (foreground via `exec`; Fly terminates TLS at edge)

opencode and sidecar are backgrounded. `run` waits for opencode's `/global/health` before starting Caddy.

### Caddy routing
- `/admin/health` → sidecar `:4097` (unauthenticated -- Fly health check)
- `/auth/*` → sidecar `:4097` (unauthenticated -- login page + form)
- All other routes → `forward_auth` cookie check via sidecar, then:
  - `/admin/*` → sidecar `:4097`
  - Static file match → our frontend (e.g. `/` → `index.html`)
  - Everything else → opencode `:4096` (API + opencode web UI via catch-all proxy to `app.opencode.ai`)

This lets `/` serve our custom frontend, while `/session/*` loads the opencode web UI, and `/event`, `/config`, etc. reach the opencode API.

### Startup timeline (~20s)
1. Fly starts VM, mounts volume, runs `/opt/dancodes/run`
2. `run` writes `version.json` for the frontend
3. opencode + sidecar start in background (sidecar is ready almost instantly)
4. opencode does SQLite migration on first boot, then ready on `:4096` (~20s)
5. `run` health-check loop detects opencode, starts Caddy on `:8080`
6. `fly deploy` exits early (before app is ready) -- no deploy-time health check configured

### Secrets (set via `fly secrets set`)
- `AUTH_PASSWORD` -- login password
- `AUTH_SECRET` -- HMAC key for signing session cookies (random string)
- `GITHUB_TOKEN` -- GitHub PAT for private repo access
- `OPENROUTER_API_KEY` -- (or whichever provider env opencode needs)

### Non-secret env (in fly.toml `[env]`)
- `GITHUB_USER` -- GitHub username for repo lookups
- `XDG_DATA_HOME` -- `/vol/opencode-state` (opencode SQLite DB lands at `$XDG_DATA_HOME/opencode/opencode.db`)

### Sidecar implementation
- Python + FastAPI, chosen for speed of development
- Bare clones in `/vol/projects/repos/`, worktrees in `/vol/projects/worktrees/`
- Repo dirs use `owner__name` convention (slash-safe)
- Worktree dirs use `owner__name__sessionId`

## Local dev

### One-time setup
```sh
# Setup python deps (requires uv)
dev/venv

# Setup node deps (requires node via nodenv, see .node-version)
dev/node-setup
```

### Build/check
```sh
# Typecheck + lint (python + frontend)
dev/check
```

### Terminal tabs
- `gh run list` -- watch deploys in github actions after push
- `fly logs` -- watch prod logs
- `dev/docker-run` -- run local dev

## Deploy (to fly.io)

### One-time setup
```sh
# Init the service in fly.io
fly apps create dancodes --org jdanbrown
fly volumes create dancodes_vol --app dancodes --region iad --size 10
fly secrets set --app dancodes AUTH_PASSWORD=... AUTH_SECRET=... GITHUB_TOKEN=... OPENROUTER_API_KEY=...

# Block force-pushes and deletion of main (server-side safety net against LLMs going rogue)
gh api repos/jdanbrown/dancodes/rulesets --method POST --input - <<EOF
{
  "name": "no-force-push-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "rules": [{"type": "non_fast_forward"}, {"type": "deletion"}]
}
EOF
```

### Deploys are automatic
- Deploys happen automatically via github actions on push to `main`

### Rollbacks
To rollback (e.g. from phone): GitHub → Actions → "Deploy to Fly.io" → Run workflow
- Set `rollback` to `1` (previous commit), `2`, etc.
- Or paste a specific commit SHA into `ref`
- No rolling/blue-green deploys (because single volume means single machine), so broken deploys require manual rollback

### To deploy manually
```sh
# Deploy to fly.io manually
# - Safe to race with github actions (last writer wins)
fly deploy
```
