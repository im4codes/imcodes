# IM.codes

A chat interface built for talking to AI coding agents. Not Slack, not Discord, not Telegram — something actually designed for the job.

## Screenshots

### Desktop

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes0.png"><img src="landing/imcodes0.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes1.png"><img src="landing/imcodes1.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes2.png"><img src="landing/imcodes2.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes3.png"><img src="landing/imcodes3.png" width="24%" /></a>
</p>

### Mobile

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m1.png"><img src="landing/imcodes-m1.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m2.png"><img src="landing/imcodes-m2.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m3.png"><img src="landing/imcodes-m3.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m4.png"><img src="landing/imcodes-m4.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m0.png"><img src="landing/imcodes-m0.png" width="18%" /></a>
</p>

## Why

Every existing chat tool is built for humans talking to humans. When you're working with Claude Code, Codex, or Gemini CLI, you need terminal output, diff views, session management, multi-agent coordination — none of which fit into a 4096-char message box with emoji reactions.

I wanted a tool I could fully customize. Something that speaks the language of code, not social media. So I built one.

This is a personal project. I haven't written any code myself — it was built almost entirely by [Claude Code](https://github.com/anthropics/claude-code), with significant contributions from [Codex](https://github.com/openai/codex) and [Gemini CLI](https://github.com/google-gemini/gemini-cli).

## What it does

- **Remote agent control** — Talk to your agents from a browser or phone. No SSH, no VPN.
- **Terminal + Chat modes** — Switch between raw terminal (the native CLI experience) and a structured chat view.
- **Multi-server, multi-session** — Manage agents across machines from one dashboard.
- **Real-time streaming** — Live terminal output, no message limits, no rate throttling.
- **Sub-sessions** — Spawn additional agents from within a session. Run parallel tasks with full visibility.
- **P2P multi-agent discussions** — Route a topic through multiple agents in sequence. Each agent reads prior contributions and adds their own. Supports discuss, audit, review, and brainstorm modes. Works across Claude Code, Codex, and Gemini CLI — including sandboxed agents.
- **File upload & download** — Upload files from browser or phone (including camera). Files are relayed to the daemon and referenced in chat with `@path`. Download project files directly from the built-in file browser.
- **Push notifications** — Get notified on your phone when an agent needs attention.
- **OTA updates** — Daemon self-upgrades via npm. Trigger from the web UI for one device or all devices at once.
- **Fully customizable** — It's your UI. Add whatever you need — diff viewers, approval flows, custom scripts.

## Architecture

```
You (browser / mobile)
        ↓ WebSocket
Server (self-hosted)
        ↓ WebSocket
Daemon (your machine, manages tmux)
        ↓ tmux
AI Agents (Claude Code / Codex / Gemini CLI / OpenCode)
```

The daemon runs on your dev machine and manages agent sessions through tmux. The server relays connections between your devices and the daemon. Everything stays on your infrastructure.

## Install

```bash
npm install -g imcodes
```

## Quick Start

Use the hosted version at [app.im.codes](https://app.im.codes), or self-host the server on your own infrastructure.

```bash
imcodes bind https://app.im.codes/bind/<api-key>
```

This binds your machine, starts the daemon, and registers it as a system service.

## Self-Host (One-Click Deploy)

Deploy your own IM.codes server with Docker Compose. Includes automatic HTTPS via Caddy and auto-updates via Watchtower.

```bash
# 1. Clone and configure
git clone https://github.com/im4codes/imcodes.git
cd imcodes
cp .env.example .env

# 2. Edit .env — set your domain and generate secrets
#    DOMAIN=im.example.com
#    POSTGRES_PASSWORD=$(openssl rand -hex 16)
#    JWT_SIGNING_KEY=$(openssl rand -hex 32)
#    BOT_ENCRYPTION_KEY=$(openssl rand -hex 32)

# 3. Start
docker compose up -d
```

That's it. Caddy automatically provisions a Let's Encrypt certificate for your domain. Watchtower checks for new images every 5 minutes and updates automatically.

Point your DNS A record to the server IP, then visit `https://your-domain`. Default login: `admin` / password shown in `docker compose logs server` on first run.

After logging in, bind your dev machine:

```bash
npm install -g imcodes
imcodes bind https://your-domain/bind/<api-key>
```

## Requirements

- macOS or Linux (tested on both). Windows users need [WSL](https://learn.microsoft.com/en-us/windows/wsl/) — native Windows is not supported since the project uses tmux to manage agent sessions.
- Node.js >= 20
- tmux
- At least one AI coding agent: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), or [OpenCode](https://github.com/opencode-ai/opencode)

## License

MIT
