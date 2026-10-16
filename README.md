# Garnado MCP

A sandboxed **MCP file-server connector**. It lets an AI agent (for example claude.ai) read, search, edit and commit files inside one folder (`workspace/`) over HTTPS, and it keeps a handoff trail so a **new agent session can continue where the last one stopped**.

Built for CS 3A / CS 3B, Week 06, "Midterms Pt 1: Build Your Own".

## What it does

- **14 single-purpose tools** (files, search, git-lite, handoff).
- **Sandbox:** every path is resolved against `workspace/`; `..`, absolute paths, null bytes, and symlink/junction escapes are rejected.
- **Two roles:** `builder` (all 14 tools) and `planner` (10 read-mostly tools), enforced on the server.
- **Auth:** the public endpoint needs a secret (bearer token or secret in the URL path).
- **Handoff protocol:** `PROJECT_STATE`, `PLAN_LOG`, `CHECKPOINTS`, `DECISIONS`, so work continues across 2+ sessions.
- **Audit log:** one JSON line per tool call in `logs/audit.jsonl`.
- **Always on:** pm2 keeps the server and the ngrok tunnel running and restarts them if they crash.

## Stack

Node.js + TypeScript, official `@modelcontextprotocol/sdk` (Streamable HTTP, stateless), `zod` schemas, Express, `dotenv`, `vitest`, ngrok (HTTPS tunnel), pm2 (process manager), git.

## Prerequisites

- Windows 11 with PowerShell (commands below are PowerShell)
- [Node.js](https://nodejs.org) 20 or newer, and git
- A free [ngrok](https://ngrok.com) account (one free static domain)
- pm2: `npm install -g pm2`
- A claude.ai account (the Free plan allows one custom connector)

> Tip: avoid putting the project inside OneDrive; installs can be slow and files can get locked.

## Setup (from zero)

### 1. Clone and install

```powershell
git clone https://github.com/Katrice65/garnado-mcp.git Garnado_MCP
cd Garnado_MCP
npm install
```

### 2. Create your `.env` (secrets)

```powershell
Copy-Item .env.example .env
```

Generate four random secrets (run each command, copy the output into `.env`):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # for MCP_TOKEN and MCP_PLANNER_TOKEN (64 hex)
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # for MCP_URL_SECRET and MCP_PLANNER_URL_SECRET (48 hex)
```

Your `.env` needs these variables, each on **one line only**:

```
MCP_TOKEN=<64 hex>
PORT=3000
MCP_URL_SECRET=<48 hex>
MCP_PLANNER_TOKEN=<64 hex>
MCP_PLANNER_URL_SECRET=<48 hex>
```

`.env` is gitignored. Never commit it or paste it anywhere.

### 3. Create the workspace repo

`workspace/` is the only folder agents can touch. It has **its own git repo**, separate from this project repo, so the agent's commits never land here.

```powershell
cd workspace
git init -b main
git config user.name "Your Name"
git config user.email "you@example.com"
Add-Content .git\info\exclude ".trash/"
git add -A
git commit -m "Initial workspace"
cd ..
```

Check: `git ls-files workspace` (run from the project root) should print only `workspace/.gitkeep`.

### 4. Build and test

```powershell
npm run build
npm test
```

Expected: the build finishes with no errors and **14 tests pass** (10 path-traversal tests and 4 link-escape tests).

### 5. Set up the ngrok tunnel

1. Install the ngrok agent (version 3.20 or newer): `winget install Ngrok.Ngrok`
2. In the ngrok dashboard, copy your authtoken and run `ngrok config add-authtoken <token>`, then clear the screen with `cls`.
3. In the dashboard, claim your free static domain (looks like `something.ngrok-free.dev`).
4. Open `ecosystem.config.cjs` and edit the `garnado-tunnel` entry for **your machine**:
   - `script`: the full path to your `ngrok.exe` (find it with `(Get-Command ngrok).Source`)
   - `args`: `http --url=<your-domain> 3000`

### 6. Start everything with pm2

```powershell
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
```

Expected: `garnado-server` and `garnado-tunnel` both `online`.

After a **reboot**, run `pm2 resurrect` to bring both back. (`pm2 startup` is not supported on Windows.)

### 7. Verify the server

Load the secrets into the current terminal (prints lengths only; expect 64, 48, 64, 48):

```powershell
foreach ($n in "MCP_TOKEN","MCP_URL_SECRET","MCP_PLANNER_TOKEN","MCP_PLANNER_URL_SECRET") {
  $v = ((Get-Content .env | Where-Object { $_ -like "$n=*" } | Select-Object -First 1) -replace "^$n=","").Trim()
  Set-Item "Env:$n" $v
}
"builder token: " + $env:MCP_TOKEN.Length + "  url: " + $env:MCP_URL_SECRET.Length + "  |  planner token: " + $env:MCP_PLANNER_TOKEN.Length + "  url: " + $env:MCP_PLANNER_URL_SECRET.Length
```

Then test the public URL (replace `<your-domain>`):

```powershell
$base = "https://<your-domain>/mcp/"
foreach ($pair in @(@("builder",$env:MCP_URL_SECRET), @("planner",$env:MCP_PLANNER_URL_SECRET), @("wrong","not-a-real-secret"))) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ($base + $pair[1]) -Method Post -ContentType "application/json" -Headers @{Accept="application/json, text/event-stream"; "ngrok-skip-browser-warning"="true"} -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
    $n = (($r.Content -split "data: ")[1] | ConvertFrom-Json).result.tools.Count
    "$($pair[0]): HTTP $($r.StatusCode), $n tools"
  } catch { "$($pair[0]): HTTP $([int]$_.Exception.Response.StatusCode)" }
}
```

Expected: `builder: HTTP 200, 14 tools`, `planner: HTTP 200, 10 tools`, `wrong: HTTP 401`.

### 8. Connect claude.ai

1. Settings → Connectors → **Add custom connector**.
2. URL: `https://<your-domain>/mcp/<MCP_URL_SECRET>` (type the secret yourself from `.env`). Choose **No sign-in**.
3. Confirm the connector shows **14 tools**.
4. Suggested permissions:
   - **Always allow:** List files, Read file, Read many files, Search code, Git status, Git diff, Git log, Get handoff, Append plan log, Save checkpoint.
   - **Needs approval:** Write file, Replace text in file, Delete file, Git commit.

To give an agent the read-mostly role instead, use the `MCP_PLANNER_URL_SECRET` in the URL.

## Tools

| Tool | What it does |
|---|---|
| `list_files` | List one folder (non-recursive, max 200 entries) |
| `read_file` | Numbered lines, 200-line cap, optional line range, shows a content version |
| `read_many_files` | Read 1 to 10 files in one call; a bad path only fails its own entry |
| `write_file` | Create a file; refuses to overwrite unless `overwrite: true` |
| `str_replace` | Replace text that matches exactly once; optional `if_version` check |
| `delete_file` | Needs `confirm: true`; moves the file to `workspace/.trash/` |
| `search_code` | Literal text search with result caps |
| `git_status`, `git_diff`, `git_log` | Read-only git views of the workspace repo |
| `git_commit` | Stage and commit (no push, reset or branch tools exist) |
| `get_handoff` | One call: project state, last plan entries, last decisions, newest checkpoint |
| `append_plan_log` | Add a timestamped plan entry (or a decision with `kind: "decision"`) |
| `save_checkpoint` | Save a new checkpoint file and update `PROJECT_STATE.md` |

**Planner role (10 tools):** `list_files`, `read_file`, `read_many_files`, `search_code`, `git_status`, `git_diff`, `git_log`, `get_handoff`, `append_plan_log`, `save_checkpoint`. The other four are never registered for planner requests.

## Handoff protocol

Agents never edit the handoff files directly (writes are refused). They use:

- `get_handoff` at the **start** of every session (first call).
- `append_plan_log` during work (decisions go to `DECISIONS.md`).
- `save_checkpoint` at the **end** (what is done, what the next session should do).

Files live in `workspace/`: `PROJECT_STATE.md`, `PLAN_LOG.md`, `DECISIONS.md`, `CHECKPOINTS/`.

## Security summary

- **Sandbox:** paths are resolved against the real workspace root, including `realpath` of the deepest existing ancestor, so symlinks and junctions cannot escape. Protected names (`.git`, `.env`, `.trash`) are off limits.
- **Auth:** constant-time hash comparison; no credential gives `401`. URL secrets must be at least 32 characters.
- **Roles are enforced on the server**, not by asking the agent to behave.
- **Destructive actions are gated twice:** the server requires `confirm: true` to delete, and the client can require approval.
- **No shell injection:** git runs through `execFile` with an argument list, never a shell string.
- **Audit log:** `logs/audit.jsonl` records time, role, tool, trimmed arguments, success and duration. File contents are logged only as `<N chars>`.

**Known limitations:** the connector on the claude.ai Free plan cannot send headers, so the secret travels in the URL path (and ngrok's traffic inspector records full URLs). The `if_version` check prevents silent overwrites between sessions but is not an atomic lock. `write_file` has no `if_version`. Everything runs on a single machine.

## Everyday commands

| Task | Command |
|---|---|
| Check processes | `pm2 status` |
| After editing code in `src/` | `npm run build` then `pm2 restart garnado-server` |
| After editing `.env` | `pm2 restart garnado-server --update-env` |
| Run tests | `npm test` |
| Open the MCP Inspector | `npm run inspect` |
| Watch logs | `pm2 logs` |

## Rotating a secret

Edit the value in `.env`, run `pm2 restart garnado-server --update-env`, and update the connector URL.

## Project layout

```
src/
  index.ts        Express app and /mcp routes
  auth.ts         credential -> role
  roles.ts        role scoping (PLANNER_TOOLS)
  audit.ts        audit log
  sandbox.ts      path resolution and escape checks
  tools/          files.ts, search.ts, git.ts, handoff.ts
test/             sandbox and link-escape tests
workspace/        the only folder agents can touch (its own git repo)
logs/             audit.jsonl and pm2 logs (gitignored)
ecosystem.config.cjs   pm2 config (server + ngrok tunnel)
```

## Troubleshooting

- **`tsx` not recognized, or `.env` missing:** you are probably in the wrong folder. Run `cd` to the project root and try again.
- **ERR_NGROK_334 (domain already in use):** stop any hand-started ngrok with `Stop-Process -Name ngrok -Force`, then `pm2 restart garnado-tunnel`.
- **Server says "misconfigured" (500):** `MCP_TOKEN` is missing or too short, or appears twice in `.env`.
- **Port 3000 in use:** do not run `npm run dev` while pm2 is running the server.
- **A tool you just added is missing for the planner:** add its name to `PLANNER_TOOLS` in `src/roles.ts`, rebuild, and restart.
