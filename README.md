# Handoff

A local dashboard for your Claude Code sessions. Read, search and analyze them in the browser, and move them between your computers so you can pick a session up on the other machine with `claude --resume`.

It runs on your own computer, reads the files Claude Code already keeps in `~/.claude`, and talks to nothing on the internet.

## Why

Claude Code saves every session as a `.jsonl` file under `~/.claude/projects/<folder>`, where the folder name is derived from the project path (`C:\Users\me\app` becomes `C--Users-me-app`). To continue a session on another PC you have to copy that file into exactly the right folder over there, which is different whenever the project lives somewhere else or your username differs. The paths inside the session still point at the old machine, and if you have been working on both PCs you can overwrite newer work without noticing.

Handoff does this for you. It puts sessions in the right place, rewrites the paths, notices when one copy continues the other, keeps backups, and gives you an undo.

## Quick start

You need [Node.js](https://nodejs.org) 20.11 or newer.

```bash
git clone <this repo> claude-handoff
cd claude-handoff
npm start
```

The first run installs dependencies and builds the app, which takes about a minute. After that it starts instantly and opens <http://localhost:7420>.

On Windows you can also double-click `start-handoff.cmd`.

Do the same on your other computer. That's the whole setup.

## Getting sessions onto your other computer

There are three ways. All of them end in the same review screen, so nothing lands on the other computer until you've seen where it goes.

| Way | Needs | Best for |
| --- | --- | --- |
| **Pair your devices** | Both computers on, on the same network, with Handoff running on both | Switching between a desktop and a laptop every day |
| **Sync folder** | A folder both computers can see: OneDrive, Dropbox, Google Drive, iCloud, Syncthing, a NAS or a USB stick | When the other computer is off, and for keeping sessions past Claude Code's 30-day cleanup |
| **Bundle file** | Nothing | One-off moves, or sending a session to someone |

### Pair your devices (local network)

1. On computer A, open **Devices** and turn on **Share on my network**. A 6-digit pairing code appears. On Windows, allow Node.js on private networks if the firewall asks.
2. On computer B, open **Devices** → **Add a device**. Pick computer A under *Found on your network* (or type its address, like `192.168.1.20:7420`) and enter the code.

Pairing works both ways: each computer can now browse the other. Open the device to see its sessions, each marked *Not here yet*, *Newer there*, *In sync* or *Diverged*. Select some and click **Pull**. To push instead, use **Hand off → Send to …** on any session; it lands in the other computer's inbox.

### Sync folder

Open **Sync folder** and pick a folder (Handoff suggests the cloud folders it finds). Copy sessions in by hand, or turn on automatic copying for all or starred sessions. On the other computer, choose the same folder: sessions show up there with their status, ready to pull.

The folder also works as an archive. Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default); copies in the sync folder stay, and you can read them in Handoff even after they're gone locally.

### Bundle file

Select sessions → **Hand off → Download a bundle**. You get one `.zip` that mirrors the `~/.claude` layout, with a manifest and a README inside. On the other computer, drop it on **Inbox**. You can also drop raw `.jsonl` files copied straight out of `~/.claude/projects`.

### The import review

For every project in the import, Handoff suggests where it lives on this computer. It tries, in order: where the same session already is, the folder you chose last time, the same path, the same path under your home folder, and a folder with the same name in your usual dev folders. You can change the folder or browse for it.

For every session it shows how it relates to what's already here:

| Status | Meaning | Default action |
| --- | --- | --- |
| New here | You don't have it | Import |
| Newer there | It continues your copy (you kept working on the other PC) | Update my copy, after backing it up |
| In sync | Identical | Skip |
| Newer here | Your copy is ahead | Skip |
| Diverged | Both copies continued separately | Import as a separate session, so both are kept |

Sessions are compared by the sequence of message IDs inside them, not by bytes, so a copy whose paths were rewritten still counts as the same session.

**Paths.** By default Handoff updates only the session details Claude Code keeps next to each message (working directory, worktree info, checkpoint paths). None of that is sent to the model. You can opt in to also rewriting paths inside the conversation itself. That's off by default: newer Claude models bind their saved reasoning to the exact conversation history, and editing earlier turns makes them set that reasoning aside when you resume.

**Also handled:** subagent transcripts, persisted tool output, checkpoints (so `/rewind` keeps working), project memory (copied only into projects that have none yet), sessions that are open in Claude Code right now (they're never overwritten), backups of anything replaced, and **Undo** for every import.

After importing you get a **Resume in a terminal** button and the exact command to copy.

## What else it does

- **Overview:** sessions open in Claude Code right now (working or waiting), recent sessions, the last 30 days at a glance and a year of activity.
- **Sessions:** every session as a compact row with project, branch, prompts, active time and cost. Filter, sort, star, tag, multi-select.
- **Reading a session:** a clean transcript with tool calls folded into one line each (diffs for edits, output for commands), reasoning, images, compaction points, rewound branches, and subagent transcripts. It also has find-in-conversation, an outline of your prompts (J/K to jump between them), live updates while Claude works, one-click resume, rename, notes, and Markdown or raw export.
- **Search** across every prompt, reply and tool call, with `"exact phrases"` and `-exclusions`.
- **Analytics:** tokens and cost per day by model, activity calendar, when you work, projects, tools and the token mix. Every chart has a table view.
- **Command palette** (Ctrl+K) and keyboard shortcuts (`?` lists them). Light and dark mode (`T`). Works on a phone too.

Costs are API-equivalent estimates at Anthropic's list prices. A Claude subscription doesn't bill per token; it's a yardstick. You can add custom prices in Settings.

## Security and privacy

- Handoff listens on `127.0.0.1` only, until you turn on network sharing.
- Requests from your own browser must come from a localhost address (this blocks DNS-rebinding pages) and, when they change anything, carry a custom header from Handoff's own page (this blocks other websites from triggering actions).
- With network sharing on, other devices need the access token (or a one-time 6-digit pairing code to get it). Remote access is read-only, apart from sending sessions to your inbox. Remote callers can't change settings, browse your folders, open terminals or import anything themselves.
- Handoff only writes to Claude Code's folder when you import or delete something. Replaced files are backed up and deletions go to a trash you can restore from.
- No analytics or external requests. Fonts and everything else are bundled.

## Command line

```
npm start -- [options]

  --port <n>          Port (default 7420; the next free one if taken)
  --lan               Turn on network sharing
  --host <addr>       Bind to a specific address (overrides --lan)
  --claude-dir <dir>  Claude Code folder (default ~/.claude or $CLAUDE_CONFIG_DIR)
  --data-dir <dir>    Handoff's own data (default ~/.claude-handoff, or $HANDOFF_DATA_DIR)
  --no-open           Don't open the browser
```

If Handoff is already running, starting it again just opens the browser.

## Where things are

- Reads: `~/.claude/projects` (sessions), `~/.claude/sessions` (which sessions are open), `~/.claude/file-history` (checkpoints) and `~/.claude/settings.json` (cleanup period).
- Writes its own data to `~/.claude-handoff`: settings, notes and stars, paired devices, the inbox, import history, backups, trash and an index cache.

## How it works

**Claude Code's files.** Each session is `projects/<encoded project path>/<session id>.jsonl`, one JSON event per line: user and assistant messages, tool results, attachments (injected context), system events (compaction, recaps), and bookkeeping lines (`ai-title`, `last-prompt`, `file-history-snapshot`, …). An assistant reply with several content blocks is split over several lines sharing one `message.id`, so token usage is de-duplicated per message. Subagents live in `<session id>/subagents/`, large tool output in `<session id>/tool-results/`, checkpoints in `file-history/<session id>/`. Running sessions register themselves in `sessions/<pid>.json`.

**Bundle.** A zip with `manifest.json` (source device, sessions, files, identity hashes), a README, and the files at their `~/.claude` paths.

**Sync folder.** `handoff-sync.json`, `devices/<device id>.json`, and one `sessions/<session id>/` folder per session with a `session.json` and the files. Pushes are written to a temp folder and swapped in, so the other computer never sees half a session. A push never overwrites a copy that is newer or has diverged, unless you force it.

**Comparing copies.** Sessions are append-only logs. Handoff hashes the sequence of message uuids: equal hashes mean in sync, and if one copy's first *n* uuids hash to the other's full hash, it continues it. Paired devices answer prefix-hash questions, so nothing large has to be transferred to compare.

## Development

```bash
npm run dev        # API with reload on :7421 + Vite on :5173
npm test           # unit and integration tests (vitest)
npm run typecheck  # server and web
npm run build      # dist/web + a single-file dist/server/index.js
```

```
src/server   Node + Hono: indexing, transcripts, search, stats, transfer, security
src/web      React + Tailwind: the dashboard
src/shared   types, path mapping and pricing used by both
test         tests, including a full export → import round trip
docs         PROMPT.md: the brief this was built from
```

## Troubleshooting

- **The other computer can't connect.** Both need network sharing on (to pair, at least the one you connect to). Check the firewall: Windows asks the first time; allow Node.js on private networks. Guest Wi-Fi networks often block devices from seeing each other.
- **An imported session doesn't show up in `claude --resume`.** Run it from the project folder the review showed. Claude Code lists sessions per folder.
- **The project folder doesn't exist here.** Clone or create it at the path shown, or re-import and pick where it actually is.
- **Port 7420 is taken.** Handoff picks the next free port, or use `--port`.
