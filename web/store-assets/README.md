# App Store Submission Guide

## App Store Connect Configuration

| Field | Value |
|-------|-------|
| App Name | IM.codes |
| Subtitle | Remote Terminal for AI Agents |
| Category | Developer Tools |
| Secondary Category | Utilities |
| Privacy Policy URL | https://im.codes/privacy.html |
| Terms of Service URL | https://im.codes/terms.html |
| Support URL | https://github.com/im4codes/imcodes |
| Bundle ID | com.im.codes |
| SKU | com.im.codes |
| Price | Free |
| Availability | All territories (consider excluding China — see note below) |

## Privacy Labels (App Privacy)

| Data Type | Collected | Linked to User | Tracking |
|-----------|-----------|----------------|----------|
| User ID | Yes | Yes | No |
| Device ID (push token) | Yes | Yes | No |

**Data not collected:** Location, contacts, browsing history, search history, diagnostics, purchases, financial info, health, fitness, sensitive info, photos, emails, messages, gameplay, advertising data.

## Review Notes

```
IM.codes is a remote terminal client for developers — similar to Termius
or Prompt, but specialized for managing AI coding agent CLI sessions.

IMPORTANT: This app does NOT provide AI services. It does not run, host,
or proxy any AI models. It is purely a terminal/SSH-like client that
connects to the user's own machines where they have independently
installed and authenticated CLI tools (Claude Code, Codex, Gemini CLI).
These are third-party open-source CLI programs that users set up on
their own computers with their own API keys.

HOW IT WORKS:
- Users install a lightweight daemon on their dev machine (macOS/Linux)
  via `npm install -g imcodes`
- The daemon manages terminal sessions through tmux (standard terminal
  multiplexer) — the same way an SSH client connects to a remote shell
- This app connects to the daemon via WebSocket for real-time terminal
  access, structured chat view, and session management
- Users can self-host the relay server on their own infrastructure,
  or use our shared demo instance for evaluation

NATIVE CAPABILITIES (not a simple web wrapper):
- Push notifications (APNs) — alerts when terminal sessions need input
- Biometric authentication (Face ID / Touch ID) via passkeys
- Speech-to-text input for hands-free terminal interaction
- Camera upload for sharing images to terminal sessions

SELF-HOSTED ARCHITECTURE:
The relay server is fully open source (GPLv3). Users are encouraged to
deploy on their own infrastructure for production use. Our hosted instance
(app.im.codes) serves only as a demo environment and push notification
relay for self-hosted installations. No user data is stored beyond
authentication credentials and device tokens for push delivery. We do
not process, store, or have access to any AI model interactions —
all traffic passes through encrypted WebSocket directly between the
user's device and their own machine.

TEST ACCOUNT:
  Server: https://app.im.codes
  Username: review
  Password: imcodes-review-2026

  After login, the app shows connected servers with terminal sessions.
  You can switch between terminal view and chat view using the toggle
  button. Push notifications can be tested by backgrounding the app.

ACCOUNT DELETION:
  Settings (gear icon) → scroll to bottom → "Delete Account"
  Requires typing "DELETE" to confirm. All data is permanently removed.
```

## App Description (English)

```
Remote terminal access for AI coding agents. Manage Claude Code, Codex,
and Gemini CLI sessions from your phone — no SSH, no VPN.

• Real-time terminal streaming with zero latency
• Structured chat view with parsed tool calls and thinking blocks
• Multi-agent discussions: audit, review, brainstorm across providers
• Push notifications when agents finish tasks or need your input
• File browser with syntax highlighting and git diffs
• Sub-sessions for parallel agent workflows
• Multi-server dashboard — manage agents across all your machines
• Self-hostable — deploy the open-source server on your own infrastructure

IM.codes is a developer tool. A daemon runs on your dev machine and
manages AI agent sessions through tmux. This app connects via WebSocket
for real-time remote access from anywhere.

Open source under GPLv3: github.com/im4codes/imcodes
```

## App Description (Chinese Simplified)

```
AI 编程代理的远程终端。从手机管理 Claude Code、Codex 和 Gemini CLI
会话——无需 SSH、无需 VPN。

• 实时终端推流，零延迟
• 结构化聊天视图，解析工具调用和思考过程
• 多代理讨论：跨供应商审计、审查、头脑风暴
• 推送通知：代理完成任务或需要输入时提醒
• 文件浏览器：语法高亮、Git 差异对比
• 子会话：并行代理工作流
• 多服务器面板：一处管理所有机器上的代理
• 可自托管：在自己的服务器上部署开源服务端

IM.codes 是开发者工具。守护进程运行在你的开发机上，通过 tmux 管理
AI 代理会话。本 App 通过 WebSocket 实现随时随地的远程访问。

开源协议 GPLv3：github.com/im4codes/imcodes
```

## Keywords

```
terminal,ssh,remote,ai,agent,claude,codex,gemini,developer,tmux
```

## China Storefront Note

Consider excluding China from availability. The app references AI model
brand names (Claude, Codex, Gemini) in the UI which may trigger review
issues under China's AI regulations. The app itself does not run AI
models — it only connects to user-managed terminals — but the branding
could cause rejection in the China storefront.

## Screenshots

Resized screenshots are in:
- `6.7/` — 1290×2796 (iPhone 14 Pro Max / 15 Plus / 16 Plus)
- `5.5/` — 1242×2208 (iPhone 8 Plus)

Upload at least 3 per device size. All 5 recommended.

## Pre-Submission Checklist

- [ ] Create test account `review` / `imcodes-review-2026` on app.im.codes
- [ ] Upload screenshots (6.7" + 5.5")
- [ ] Fill App Store Connect metadata (name, subtitle, description, keywords, URLs)
- [ ] Select privacy labels
- [ ] Paste review notes
- [ ] Verify app icon (1024×1024 in Xcode asset catalog)
- [ ] Archive → Upload to App Store Connect
- [ ] TestFlight validation
- [ ] Submit for review
