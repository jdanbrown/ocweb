# Working model
This project is built entirely from a phone, chatting with an llm
- The human never writes or reads the code directly, the llm does all code work.
- The llm does all the work -- read/write code, run checks/test, read logs, etc.
- The human does actively view and use the web app in a mobile browser, but beyond that their hands-on capabilities are very limited
- Some steps like deploys should be automated (see `README.md` for authority)

## Docs
- `README.md` -- purpose and design
- `AGENTS.md` -- working model for llms (this doc)
- `MEMORY.md` -- institutional memory for llms
- `BACKLOG.md` -- backlog of ideas for the future

## Guiding principles
- **Close the loop**
  - The human can only verify by using the web app on a phone, so you (the llm) must verify changes the best you can before considering them done
- **Institutional memory**
  - The human has no low-level details of the system in their head because they didn't write the code, make the mistakes, and reason through how to solve each problem that came up
  - You need to persist working knowledge through many disparate chat sessions using code comments, and docs like `MEMORY.md` and `README.md`
- **Favor boring code**
  - Prefer obvious, explicit code over clever, surprising code
  - The human isn't in the loop on the code, so the next llm session needs to understand it cold
- **Keep it small, keep it simple**
  - We aren't at ASI/AGI yet (speaking from 2026) -- keep the complexity and subtleties of the system manageable by an llm, resist over-engineering
  - Design for future changes and understandability from the perspective of an llm (e.g. rewrites are cheap)
- **Observability**
  - Good observability (logging, error msgs, etc.) is critical to understanding and debugging a system, by llms or humans

## Working style
- This is a personal-use project -- optimize for simplicity and speed over polish
- Cut corners on scale, resource multiplexing, multi-tenancy -- it's one user on one machine
- Surface internal state to the user rather than hiding it -- better to see and control than to hide away
- If a solution seems unreasonably complex, pause and discuss approaches before diving in

## Institutional memory
- Update `README.md` when design or architecture changes
- Update `MEMORY.md` if you learned something worth writing down for future llm sessions
- Always read `MEMORY.md` at the start of each session to avoid repeating past mistakes and surprises

## Codebase review
- Track the last review date and commit sha in `MEMORY.md` under "Last codebase review"
- If the last review was a while ago (~20 commits), let the human know, "We haven't done a codebase review since <date> <commit>"
- If they ignore it, then focus on their task and leave the codebase review for a future llm session -- don't derail their focus
- If they go for the codebase review, then update `MEMORY.md` afterwards to reflect

## Backlog
- Don't read `BACKLOG.md` by default -- load it only when the human asks about the "backlog"
- Update `BACKLOG.md` if the human asks you to save something to the "backlog"
- Don't add to `BACKLOG.md` if the human doesn't explicitly mention "backlog" -- e.g. "save that for later" often means within the same session, not "go write this down in a file for another day"

## Coding style
- No trailing whitespace at the end of lines
- Always one trailing newline at the end of the file
- Always trailing commas (on languages that allow it)
- Add comments sparingly
  - Don't add comments about things that are self-evident from the code
  - Do add comments explaining the "why" of the code, when it's not self-evident
  - Do add comments to explain things that are non-obvious, tricky, or gotchas to avoid
  - Do use comments to label or structure large or complex blocks of code
  - Don't add comments explaining that you removed some code in an edit -- the code is gone, future readers don't care!
  - Don't include comments about each diff to the code, only comments that are useful looking at the latest state
- Make the "what" self-evident through clear naming and structure. Use comments to explain why the code does this "what" instead of other "whats".

## Writing style
- Prefer bullets to paragraphs
  - One bullet per major thought: one bullet per sentence is a good rule of thumb -- not too short, not too long
  - If a line has to wrap a lot (e.g. >>120 chars), then it probably has enough thoughts that it'd be better broken into multiple bullets
  - Use this AGENTS.md as a good example
  - When in doubt, follow the existing style
- Stick to ascii in our files, because for some reason opencode's `read` tool strips non-ascii and messes up llm edits
  - e.g. use `--` instead of `—`, and normal quotes instead of smart quotes
  - The one exception is user-facing text in web/gui environments, where we do want e.g. `—` instead of `--` (but who cares about smart quotes)

### Python style
- No empty `__init__.py` files (that's a py2 thing)
- Order code top-down: public api / endpoints first, models and helpers below
  - Reader should encounter purpose before details, not the other way around
  - Exception: types/models must be defined before they're referenced, so they go above endpoints

## Git workflow
- Each session works in its own worktree on a `dancodes/{sessionId}` branch
- The sidecar creates worktrees from `origin/main` (fetches first), so sessions always start from the latest code
- All sessions target `origin/main` -- no long-lived branches, no PRs
- Don't commit or push until the human says so, so that the current session's changes stay visible in git diff/status
- When pushing:
  1. `git fetch origin`
  2. `git rebase origin/main` -- resolve any conflicts
  3. `git push origin HEAD:main`
  4. If push fails (someone else pushed), repeat from step 1

## Tests/checks
- Always run `dev/check` and confirm it passes before committing
  - If it fails, fix the issues and re-run until it passes
  - Don't commit or push with failing checks -- the human can't fix these from their phone
- Before committing, read `BACKLOG.md` and remove any items completed by the commit (we don't keep completed backlog items)

## Searching docs and examples
- Code apis change often -- eagerly search with `context7` tool to avoid outdated knowledge
- Use `github_grep` to search for code examples across github repos
- Use `webfetch` to search the web -- prefer duckduckgo (simple html), not google (requires js)

## Tools
- There's an LSP server that runs continuously, so expect to see spurious compile/analysis errors reported after every intermediate code edit you make
  - Don't let these distract you -- they don't indicate real problems until you've finished your edits
  - But do fix up LSP errors once your intermediate edits are done -- don't leave a mess
- This is a small repo, so feel free to list the whole thing
