# The brief

This is the prompt this project was built from, written so you can reuse it: paste it into Claude Code (or hand it to anyone) to build, rebuild or extend a dashboard like this. There's a short version for the general dashboard, a short version for the move-between-computers problem, and the full brief that combines both.

---

## Short prompt: a dashboard for Claude Code sessions

```
Build a local web dashboard for my Claude Code sessions, in a new folder here. Commit as you go.

Claude Code stores every session as JSONL under ~/.claude/projects/<encoded project path>/<session-id>.jsonl
(look at the real files on this machine before you design anything). The dashboard runs on my computer,
reads those files, and never sends anything to the internet.

It should let me:
- see which sessions are open right now and what I worked on recently
- browse all sessions with title, project, branch, dates, prompts, tool calls, tokens and cost; filter, sort, star
- read a session as a clean conversation: tool calls collapsed to one line (diffs for edits, output for
  commands), reasoning, images, compaction points, subagent transcripts; live updates while Claude works
- search every prompt, reply and tool call across all sessions
- see analytics: tokens and cost over time by model, activity calendar, projects, tools
- resume a session with one click (open a terminal running claude --resume in the right folder)

Light and dark mode. It must hold up with sessions of 100 MB+ and thousands of sessions. Think about what
else a heavy Claude Code user would want and include it. Test it against my real sessions without
modifying them.
```

## Short prompt: moving sessions between computers

```
I use Claude Code on two PCs. To continue a session on the other one I currently copy the .jsonl by hand.
Make that painless, and better than copying files.

Facts to design around:
- Claude Code finds sessions by folder: ~/.claude/projects/<project path with every non-alphanumeric
  character replaced by "-">/<session-id>.jsonl. If the project lives at another path on the other PC
  (or my username differs), the file must go into that path's folder.
- Paths inside the session (cwd on every line, checkpoints, worktree info) point at the old machine.
- Sessions are append-only logs. If I continue a session on PC B and bring it back, A's copy is a prefix of
  B's. If I worked on both, they diverged, and neither may overwrite the other.
- Related files: <session-id>/subagents/, <session-id>/tool-results/, ~/.claude/file-history/<session-id>/.

I want:
1. Pair the two PCs on my network (short code, not typing tokens) and pull or push sessions directly.
2. A sync folder (OneDrive/Dropbox/USB) for when the other PC is off; also an archive past Claude Code's
   30-day cleanup.
3. Export one zip, import it anywhere by drag and drop.
All three end in one review screen: where each project lives on this PC (suggest it smartly), what
happens to each session (new / newer there / in sync / newer here / diverged), backups, undo, and a resume
button afterwards. Compare copies by message ids, not bytes, so rewriting paths doesn't break the
comparison. Never overwrite a session that's open in Claude Code. Secure by default: localhost only,
token-protected and read-only for other devices.
```

---

## The full brief

### Context

Claude Code (the CLI) keeps its state in `~/.claude` (or `$CLAUDE_CONFIG_DIR`). What matters here, verified on Claude Code 2.1.x:

- **Sessions:** `projects/<encoded>/<session-id>.jsonl`, where `<encoded>` is the absolute project path with every non-alphanumeric character replaced by `-` (`C:\Users\me\my_app` → `C--Users-me-my-app`). The encoding is lossy, so read the real path from the `cwd` fields inside the files.
- **Lines** are JSON events: `user`, `assistant`, `system` (subtypes like `compact_boundary`, `away_summary`, `turn_duration`), `attachment` (injected context: environment, memory files, hook output…), and bookkeeping (`ai-title`, `last-prompt`, `mode`, `permission-mode`, `file-history-snapshot`, `file-history-delta`, `queue-operation`, `relocated`, `worktree-state`, `fork-context-ref`…). Lines with conversation content carry `uuid`, `parentUuid`, `timestamp`, `cwd`, `gitBranch`, `version`, `sessionId`.
- **Assistant replies** with several content blocks (thinking, text, tool_use) are split over several lines that share `message.id`. Usage on early lines can be partial, so take the maximum per field per message id, or you'll double count. Synthetic messages have model `<synthetic>`.
- **Tool results** are `user` lines whose content holds `tool_result` blocks; structured details (stdout/stderr, structured patches for edits, agent ids) are in `toolUseResult`.
- **Titles:** `ai-title` (written by Claude Code), `custom-title` if renamed, `summary` in older versions; otherwise the first real prompt. Slash commands, command output, caveats, `!` shell commands and task notifications are user lines too, and need recognizing.
- **Rewinds/edits** leave abandoned branches in the file; the active conversation is the parent chain from the last message.
- **Related files:** `projects/<encoded>/<id>/subagents/agent-*.jsonl` (+ `.meta.json`), `projects/<encoded>/<id>/tool-results/*`, `file-history/<id>/*` (checkpoints for `/rewind`), `projects/<encoded>/memory/` (project memory).
- **Live sessions:** each running Claude Code process writes `sessions/<pid>.json` with `sessionId`, `cwd`, `status` (busy/idle), `name`. Check the pid is alive.
- `settings.json` may set `cleanupPeriodDays` (default 30): older transcripts are deleted.
- **Newer models bind saved reasoning (thinking blocks) to the exact conversation history.** Editing earlier turns makes the model drop that reasoning on resume. Thinking blocks and signatures must never be modified.

### Goals

1. A dashboard that makes a heavy user's sessions easy to find, read, search, and understand (cost, activity).
2. Moving sessions between computers that is safe, quick and needs no file juggling.
3. Zero configuration on a fresh machine: clone, one command, done. Runs on Windows, macOS and Linux.

### Non-goals

Editing conversations, running Claude, or cloud hosting. Everything stays on the user's machines.

### Dashboard features

- **Overview:** open sessions (working/waiting), inbox items waiting for review, a warning about the cleanup period when nothing archives sessions, recent sessions, 30-day stats, a year calendar.
- **Session list:** dense rows (title, project, branch, when, prompts, active time, cost, tool calls, live state, moved-from-another-machine marker). Filters (text, project, time, open now, starred, moved), sorting, multi-select with bulk hand-off/star/delete.
- **Session view:** the conversation with your prompts set apart, Claude's replies as markdown, tool calls folded to one line each with status and duration (expand for command + output, diff, file content, todo list, agent prompt/result), reasoning (and short progress notes), images, slash commands and their output, compaction markers with the kept summary, recaps, rewound branches collapsed, injected context hidden by default, subagent transcripts. Find-in-conversation, prompt outline with keyboard navigation, live follow while Claude works. Header with resume (open a terminal / copy command for PowerShell, cmd, bash), rename, star, notes, tags, export to Markdown and raw JSONL, open folder, delete (to a restorable trash).
- **Search** across all sessions: AND terms, quoted phrases, exclusions, filter by project and by who said it; results grouped by session, linking to the exact message.
- **Analytics** with a date range and project filter: totals, tokens and cost per day by model (stacked), activity calendar, hour-of-week heatmap, projects by cost, tools, token mix, per-model table. API-equivalent costs from current list prices, with custom overrides. Token usage de-duplicated by message id across files.
- Command palette, keyboard shortcuts, light/dark/system theme, responsive down to phone width.

### Moving sessions between computers

- **Bundle:** a zip mirroring `~/.claude` (sessions + subagents + tool results + optional checkpoints + optional project memory) with a manifest naming the source device, home and Claude folder. Cut active files at the last complete line. Accept raw `.jsonl` too.
- **Paired devices:** opt-in network sharing; discovery on the LAN; pairing with a short-lived 6-digit code that exchanges tokens both ways. Browse a device's sessions with sync status; pull; push into its inbox.
- **Sync folder:** a folder both machines see. One directory per session with metadata; atomic swaps; never overwrite a newer or diverged copy; optional automatic copying (open sessions at most every few minutes); readable as an archive.
- **One review screen for everything:**
  - Map each source project path to a local folder. Suggest, in order: where the session already lives, the last choice, the same path, the same path under this home folder, a same-named project or folder in common dev folders. Allow typing or browsing; flag missing folders.
  - Status per session from comparing message-uuid sequences (hash of the whole sequence and of prefixes; paired devices answer prefix-hash queries): new, newer there (update in place), in sync (skip), newer here (skip), diverged (import as a separate session with fresh ids, so both survive).
  - Never update a session that's open in Claude Code. Back up what gets replaced. Write atomically.
  - Rewrite paths in metadata (cwd, worktree info, checkpoint paths) by default; rewriting inside the conversation is opt-in, with the reasoning trade-off explained. Match Windows paths case-insensitively in every textual form (`C:\`, `C:/`, `/c/`, JSON-escaped), whole segments only, longest rule first in a single pass, converting separators between Windows and POSIX.
  - Afterwards: resume buttons and commands, and undo (delete what was created, restore backups).

### Security

- Bind to loopback by default. Check that the `Host` header is a loopback name (DNS rebinding). State changes must be same-origin and carry a custom header (CSRF).
- With network sharing on, require a token (bearer header for devices, HttpOnly SameSite=Strict cookie for browsers). Remote callers get read access plus the device endpoints only: no settings, folder browsing, terminals or imports. Pairing is rate limited and codes burn after a few wrong tries.
- Validate zip entries (no absolute paths, no `..`, only the expected top-level folders). Sanitize all rendered markdown; tool output can contain hostile HTML.

### Quality bar

- Index incrementally with a cache keyed by size and mtime; stream-parse with byte offsets so single lines (images, full tool output) can be fetched later; keep images out of the transcript payload.
- Live updates via file watching and server-sent events.
- Tests: path encoding and rewriting, pricing, line transforms (thinking untouched, copy mode re-keys consistently), uuid comparison, security rules, and an end-to-end export → import → continue → re-import → diverge → undo round trip on temporary folders. Verify against real sessions read-only, and click through the real UI in both themes.
- Plain, specific interface copy: sentence case, verbs on buttons, errors that say what to do.
