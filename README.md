# [IM.codes](https://im.codes)

[English](README.md) | [简体中文](README.i18n/README.zh-CN.md) | [繁體中文](README.i18n/README.zh-TW.md) | [Español](README.i18n/README.es.md) | [Русский](README.i18n/README.ru.md) | [日本語](README.i18n/README.ja.md) | [한국어](README.i18n/README.ko.md)

**The IM for agents. One memory layer across agents and AI providers.**

IM.codes gives coding agents one shared memory layer across providers. It turns completed work into reusable context, then injects the right history back into future sessions across [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), GitHub Copilot, Cursor, OpenCode, [OpenClaw](https://openclaw.com), [Qwen](https://github.com/QwenLM/qwen-agent), and more — with terminal access, file browsing, git views, localhost preview, notifications, multi-agent workflows, and native streaming output for transport-backed agents.

> **Disclaimer:** This is an actively developed personal open-source project. There are no warranties, no SLA, and no guarantees of stability, security, or backward compatibility. Use at your own risk. Breaking changes may happen at any time without notice.

### Breaking Changes

- **PostgreSQL image changed to `pgvector/pgvector:pg16`** (was `postgres:16-alpine`). Required for multilingual vector search in shared agent memory. Existing self-hosted deployments must update their `docker-compose.yml`:
  ```yaml
  postgres:
    image: pgvector/pgvector:pg16   # was: postgres:16-alpine
  ```
  This is a drop-in replacement — data volumes are fully compatible. The pgvector extension is enabled automatically by the server migration on first startup.

## Screenshots

### Desktop

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-sidebar.png"><img src="landing/imcodes-sidebar.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes0.png"><img src="landing/imcodes0.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes1.png"><img src="landing/imcodes1.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes2.png"><img src="landing/imcodes2.png" width="24%" /></a>
</p>

### iPad / Tablet

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad2.png"><img src="landing/imcodes-ipad2.png" width="48%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad3.png"><img src="landing/imcodes-ipad3.png" width="48%" /></a>
</p>

### Mobile

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m6.png"><img src="landing/imcodes-m6.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m7.png"><img src="landing/imcodes-m7.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m8.png"><img src="landing/imcodes-m8.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m5.png"><img src="landing/imcodes-m5.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m1.png"><img src="landing/imcodes-m1.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m2.png"><img src="landing/imcodes-m2.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m3.png"><img src="landing/imcodes-m3.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m4.png"><img src="landing/imcodes-m4.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m0.png"><img src="landing/imcodes-m0.png" width="18%" /></a>
</p>

### Apple Watch

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch1.png"><img src="landing/imcodes-watch1.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch0.png"><img src="landing/imcodes-watch0.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch2.png"><img src="landing/imcodes-watch2.png" width="31%" /></a>
</p>

Watch support covers quick session monitoring, unread counts, push notifications, and quick replies directly from the wrist.

## Download

<a href="https://apps.apple.com/us/app/im-codes/id6761014424"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40" alt="Download on the App Store" /></a>

Supports iPhone, iPad, and Apple Watch. Also available as a [web app](https://app.im.codes).

## Why

When you leave your desk, most coding-agent workflows fall apart. The agent is still running in a terminal, but continuing the work usually means SSH, tmux attach, remote desktop hacks, or waiting until you're back at your laptop.

[IM.codes](https://im.codes) keeps those sessions within reach from mobile or web: open the terminal, inspect files and git changes, preview localhost from another device, get notified when work finishes, and keep multiple agents moving on your own infrastructure.

It is not another AI IDE or a generic remote terminal. It is the messaging/control layer around terminal-based coding agents.

This is a personal project. I haven't written any code myself — it was built almost entirely by [Claude Code](https://github.com/anthropics/claude-code), with significant contributions from [Codex](https://github.com/openai/codex) and [Gemini CLI](https://github.com/google-gemini/gemini-cli).

## Shared Agent Context & Memory

IM.codes continuously turns completed agent work into reusable memory and feeds that context back into future sessions.

- **Problem → solution memory, not log spam.** Only final `assistant.text` outputs are materialized. Streaming deltas, tool calls, and intermediate noise are excluded.
- **Personal memory with optional cloud sync.** Raw and processed memory always stay local; processed summaries can optionally sync to a user-scoped cloud pool shared across your devices.
- **Enterprise shared context.** Teams can publish reusable memory into workspace/project scopes, inspect it in the UI, query it, and see stats instead of treating context as hidden prompt text. This part is still under active development and has not been fully production-tested yet.
- **Multilingual recall.** Local semantic search and server-side pgvector recall use multilingual embeddings, so related fixes can be found across English, Chinese, Japanese, Korean, Spanish, Russian, and mixed-language repos.
- **Automatic injection where it matters.** Relevant past work is injected both per-message and at session startup, with timeline cards that show what was recalled, why, the relevance score, recall count, and last-used time.
- **User-visible inspection and control.** Shared Context UI separates raw events, processed summaries, cloud memory, and enterprise memory, with query, preview, archive/restore, and processing configuration controls.

## Features

### Remote Terminal

Full terminal access to your agent sessions from any browser — no SSH, no VPN, no port forwarding. Switch between raw terminal mode (the native CLI experience) and a structured chat view with parsed tool calls, thinking blocks, and streaming output. Real-time PTY streaming at 12fps with zero message limits.

### File Browser & Git Changes

Browse project files with a tree view. Upload files, images, and photos from any device — download files directly from the server. Changes tab shows git status with per-file `+additions`/`-deletions` line counts in color. Click a file to open a floating preview window with syntax highlighting, diff view, and auto-refresh every 5s. Pin the file browser to the sidebar — it follows the active tab's project directory automatically.

### Local Web Preview

Preview your local dev server from any device — phone, tablet, or remote browser — without deploying. The daemon proxies `localhost` traffic through a secure WebSocket tunnel to the server. HTML rewriting and a runtime patch handle URL remapping so links, fetch, and WebSocket connections just work. Supports HMR/hot-reload via WebSocket tunneling. No public URLs, no third-party tunnels — traffic stays within your IM.codes server.

### Mobile, Watch & Notifications

Full mobile support with biometric auth and push notifications. Shell sessions allow interactive keyboard input on mobile (SSH-like). Sub-session preview cards always show latest messages. Toast notifications navigate directly to the relevant session. Apple Watch support adds quick session monitoring, unread counts, and quick replies from the wrist.

### Multi-Agent Discussions & Cross-Provider Audit

Single-model output shouldn't be trusted blindly. P2P discussions let multiple agents — across different providers and thinking styles — collaborate on the same codebase before a single line is written. Each round follows a customizable multi-phase pipeline where every agent reads all prior contributions and builds on them. Different models catch different classes of issues: one spots a race condition, another flags a missing migration, a third questions the API design. This cross-provider scrutiny catches the majority of problems before implementation, dramatically reducing rework cycles.

Built-in modes include `audit` (structured audit → review → plan pipeline), `review`, `discuss`, and `brainstorm` — or define your own phase sequence. Ring progress indicator shows round/hop completion in the sidebar. Works across Claude Code, Codex, Gemini CLI, and Qwen, including sandboxed agents. Configure participants, round counts, modes, and per-session P2P settings via `@@all(config)` or the UI.

### Streaming Transport Agents

Native streaming output support for transport-backed agents like [Claude Code SDK](https://github.com/anthropics/claude-agent-sdk-typescript), [Codex SDK](https://github.com/openai/codex/tree/main/sdk/typescript), [OpenClaw](https://openclaw.com), and [Qwen](https://github.com/QwenLM/qwen-agent). These agents connect via network protocols or local SDKs instead of terminal scraping, delivering structured event streams with real-time delta updates, tool call tracking, and session restore.

> **Note on OpenClaw:** `imcodes connect openclaw` has only been tested on macOS so far.

### Agent-to-Agent Communication

Agents can message each other directly using `imcodes send`. An agent running in one session can ask a sibling to review code, run tests, or coordinate on a task — no user intervention needed. Target resolution by label, session name, or agent type. `--reply` flag instructs the target to send its response back automatically. Built-in circuit breakers prevent abuse (depth limit, rate limiting, broadcast cap).

```bash
imcodes send "Plan" "review the changes in src/api.ts"
imcodes send "Cx" "run tests" --reply
imcodes send --all "migration complete, check your end"
```

Beyond agent-to-agent chat, you can use `script` sessions to build custom automation. A Python script running in a script session can call `imcodes send` to trigger agents based on any external event:

```python
# monitor.py — watch a log file, trigger agent when errors appear
import subprocess, time

while True:
    with open("/var/log/app.log") as f:
        for line in f:
            if "ERROR" in line:
                subprocess.run([
                    "imcodes", "send", "Claude",
                    f"Fix this error and write the patch to /tmp/fix.patch:\n{line}"
                ])
    time.sleep(30)
```

```bash
# Webhook → agent: GitHub webhook handler triggers code review
curl -X POST https://your-server/webhook -d '{"pr": 42}' \
  && imcodes send "Gemini" "review PR #42, write summary to /tmp/review.md"

# CI → agent: post-build trigger
imcodes send "Claude" "tests failed on main, check CI log at /tmp/ci.log and fix" --reply
```

Use cases: log monitoring → auto-fix, webhook-triggered code review, CI failure auto-diagnosis, scheduled data pipeline checks, custom approval workflows with output written to specific files for human review.
### @ Picker — Smart Agent & File Selection

Type `@` to search project files, `@@` to select agents for P2P dispatch. `@@all(config)` sends to all configured agents with saved per-session P2P settings (mode, rounds, participants). Custom round counts via `@@all+`. The picker integrates with the structured WS routing — daemon handles all expansion, frontend stays clean.

### Multi-Server, Multi-Session Management

Connect multiple dev machines to one dashboard. Each machine runs a lightweight daemon that manages local agent sessions via tmux. See all servers and sessions at a glance — start, stop, restart, or switch between them instantly. Sub-sessions let you spawn additional agents from within a running session for parallel tasks. Draggable tabs with pin support and right-click context menus.

### Discord-Style Sidebar

Server icon bar for instant multi-server switching. Hierarchical session tree with collapsible sub-sessions, unread message badges, and idle flash animation when agents finish tasks. Pin any floating window (file browser, repository, sub-session chat) to the sidebar for persistent access. Language switcher and build info at the bottom.

### Pinnable Panels

Drag any floating window to the sidebar to pin it as a persistent panel. Supports file browser, repository page, sub-session chat, and terminal views. Panels are resizable, server-synced (cross-device), and auto-recover on reconnect. Generic registry — new panel types register in one file.

### Repository Dashboard

View issues, pull requests, branches, commits, and CI/CD runs directly in the app. Silent background refresh — no more pull-to-refresh jitter. CI status auto-polls (10s when running, 15s otherwise). Pin the repository page to the sidebar for always-on visibility.

### Scheduled Tasks (Cron)

Automate recurring agent workflows with cron-style scheduling. Create scheduled tasks that send commands to specific sessions or trigger multi-agent P2P discussions on a timetable. Visual cron picker for common intervals, timezone-aware scheduling, and manual "Run Now" for testing. Execution history with expandable result detail — click any record to navigate to the target session and quote the result for follow-up. Cross-job execution list with Latest/All modes and multi-server filtering.

### Cross-Device Sync

Tab order, pinned tabs, and pinned sidebar panels sync across devices via the server preferences API. Write-through cache pattern: localStorage for instant render, debounced server PUT for cross-device consistency. Timestamped payloads for conflict resolution. Device-specific state (sidebar width, panel heights, view mode) stays local.

### Internationalization

7 languages: English, 简体中文, 繁體中文, Español, Русский, 日本語, 한국어. Language switcher in the sidebar footer. All user-visible strings use i18n keys.

### OTA Updates

Daemon self-upgrades via npm. Trigger from the web UI for one device or all devices at once.

## What IM.codes is not

- Not another AI IDE
- Not just a chat wrapper
- Not just a remote terminal client
- Not a replacement for Claude Code, Codex, Gemini CLI, OpenClaw, or Qwen
- It is the messaging/control layer around them

## Architecture

```
You (browser / mobile)
        ↓ WebSocket
Server (self-hosted)
        ↓ WebSocket
Daemon (your machine)
        ↓ tmux / transport
AI Agents (Claude Code / Codex / Gemini CLI / OpenClaw)
        ↔ imcodes send (agent-to-agent)
```

The daemon runs on your dev machine and manages process-backed agent sessions through tmux or transport-backed sessions through network protocols / local SDKs (for example Claude Code SDK, Codex SDK, OpenClaw gateway, and Qwen). Agents can communicate with each other via `imcodes send`. The server relays connections between your devices and the daemon. Everything stays on your infrastructure.

## Install

```bash
npm install -g imcodes
```

## Quick Start

> **Self-hosting is strongly recommended.** The shared instance at `app.im.codes` is for testing only — it comes with no uptime guarantees, may be rate-limited, and could be targeted. This is a personal project with no commercial support. For anything beyond evaluation, deploy the server on your own infrastructure.

Use [app.im.codes](https://app.im.codes) for evaluation, or self-host for anything real.

```bash
imcodes bind https://app.im.codes/bind/<api-key>
```

This binds your machine, starts the daemon, registers it as a system service, and brings the machine into the web/mobile dashboard.

### OpenClaw Connect

If OpenClaw is running locally, connect IM.codes to the OpenClaw gateway on the daemon machine:

```bash
imcodes connect openclaw
```

What this does:

- connects to `ws://127.0.0.1:18789` by default
- reuses the OpenClaw gateway token automatically from `~/.openclaw/openclaw.json`
- syncs OpenClaw sessions and child sessions into IM.codes so they appear as transport-backed sessions/sub-sessions
- saves the IM.codes-side connection config to `~/.imcodes/openclaw.json`
- restarts the daemon so OpenClaw transport sessions can reconnect automatically

Common variants:

```bash
imcodes connect openclaw --url ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=... imcodes connect openclaw
imcodes connect openclaw --url wss://gateway.example.com
```

Notes:

- remote non-TLS `ws://` URLs require `--insecure`
- use `imcodes disconnect openclaw` to remove the saved config and drop the connection
- this flow has only been tested on macOS

## Self-Host

### One-Command Setup

Deploy server + daemon on a single machine. Requires Docker and a domain with DNS pointing to the server.

```bash
npm install -g imcodes
mkdir imcodes && cd imcodes
imcodes setup --domain imc.example.com
```

This generates all config, starts PostgreSQL + server + Caddy with automatic HTTPS, creates the admin account, and binds the local daemon — all in one step. Credentials are printed at the end.

To connect additional machines:

```bash
npm install -g imcodes
imcodes bind https://imc.example.com/bind/<api-key>
```

### Manual Setup

If you prefer to configure manually:

```bash
git clone https://github.com/im4codes/imcodes.git && cd imcodes
./gen-env.sh imc.example.com        # generates .env with random secrets, prints admin password
docker compose up -d
```

The generated `docker-compose.yml` already uses `pgvector/pgvector:pg16` for PostgreSQL.

Login at `https://your-domain` with `admin` and the printed password. Bind your dev machine with `imcodes bind`.

## Windows (experimental)

Windows is natively supported via [ConPTY](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/) (built-in on Windows 10+). No WSL required.

### Install & Bind (Windows)

```cmd
npm install -g imcodes
imcodes bind https://app.im.codes/bind/<api-key>
```

### Upgrade (Windows)

```cmd
imcodes upgrade
```

Or upgrade remotely from the web dashboard (sends upgrade command to the daemon).

### Troubleshooting (Windows)

If the daemon stops after an auto-upgrade, regenerate the launch chain:

```cmd
imcodes repair-watchdog
```

This rewrites the watchdog script and scheduled task with the current Node.js and imcodes paths. Needed after Node.js version switches (nvm, fnm) or if the daemon won't restart after upgrade.

If `imcodes` is "not recognized as internal or external command" after upgrade, the npm global directory may not be on your PATH. Fix it:

```cmd
npm prefix -g
```

Copy the output path and add it to your PATH:

```cmd
setx PATH "<npm-prefix-path>;%PATH%"
```

Then open a **new** terminal window.

Check the daemon watchdog log for errors:

```
%USERPROFILE%\.imcodes\watchdog.log
```

## Requirements

- macOS or Linux (tested on both)
- **Windows (experimental)**: Native support via ConPTY (built-in on Windows 10+). Just `npm install -g imcodes` — no extra software needed. WSL also works.
- Node.js >= 22
- Terminal multiplexer: [tmux](https://github.com/tmux/tmux) (Linux/macOS). Windows uses ConPTY (auto-detected, built-in).
- At least one AI coding agent: [Claude Code](https://github.com/anthropics/claude-code) (CLI or SDK), [Codex](https://github.com/openai/codex) (CLI or SDK), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [OpenClaw](https://openclaw.com), or [Qwen](https://github.com/QwenLM/qwen-agent)

## Disclaimer

IM.codes is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Google, Alibaba, OpenClaw, or any other company whose products are mentioned. All product names, trademarks, and registered trademarks are the property of their respective owners.

## License

[MIT](LICENSE)

© 2026 [IM.codes](https://im.codes)
