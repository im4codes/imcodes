# [IM.codes](https://im.codes)

[English](../README.md) | [簡體中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [한국어](README.ko.md)


**給 AI agent 的 IM。共享記憶、受監督執行，以及跨模型審計。**

IM.codes 為 coding agent 提供一套跨 provider 共享的記憶層。它會把已完成的工作沉澱成可重用上下文，再把合適的歷史注入後續 session，貫通 [Claude Code](https://github.com/anthropics/claude-code)、[Codex](https://github.com/openai/codex)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、GitHub Copilot、Cursor、OpenCode、[OpenClaw](https://openclaw.com)、[Qwen](https://github.com/QwenLM/qwen-agent) 等，同時提供終端存取、檔案瀏覽、Git 視圖、localhost 預覽、通知、多 agent 工作流，以及 transport 型 agent 的原生串流輸出。內建 Auto supervision 可在每輪完成後判斷任務是否完成、是否繼續自動執行，並可選進入審計/返工閉環後再把控制權交還給你。內建 P2P 討論功能，讓多個模型互相審閱對方的方案和實作，能有效減少單模型的遺漏、盲點和偏差。

> **說明：** 本文件是中文翻译版。**英文 README（`../README.md`）是規範版本。** 若内容存在差异，以英文版为准。

支援多個 agent 透過 CLI 和 SDK 兩種方式接入。

## 截圖

### 桌面端

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-sidebar.png"><img src="../landing/imcodes-sidebar.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes0.png"><img src="../landing/imcodes0.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes1.png"><img src="../landing/imcodes1.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes2.png"><img src="../landing/imcodes2.png" width="24%" /></a>
</p>

### iPad / 平板

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad2.png"><img src="../landing/imcodes-ipad2.png" width="48%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad3.png"><img src="../landing/imcodes-ipad3.png" width="48%" /></a>
</p>

### 手機

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m6.png"><img src="../landing/imcodes-m6.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m7.png"><img src="../landing/imcodes-m7.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m8.png"><img src="../landing/imcodes-m8.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m5.png"><img src="../landing/imcodes-m5.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m1.png"><img src="../landing/imcodes-m1.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m2.png"><img src="../landing/imcodes-m2.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m3.png"><img src="../landing/imcodes-m3.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m4.png"><img src="../landing/imcodes-m4.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m0.png"><img src="../landing/imcodes-m0.png" width="18%" /></a>
</p>

### Apple Watch

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch1.png"><img src="../landing/imcodes-watch1.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch0.png"><img src="../landing/imcodes-watch0.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch2.png"><img src="../landing/imcodes-watch2.png" width="31%" /></a>
</p>


手表支持会话快速檢視、未读计数、推送通知，以及直接在手腕上快速回复。

## 下载

<a href="https://apps.apple.com/us/app/im-codes/id6761014424"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40" alt="Download on the App Store" /></a>

支持 iPhone、iPad 和 Apple Watch。也可以通过 [Web App](https://app.im.codes) 使用。

## 為什麼做這個

当你离开电脑时，大多数 coding-agent 工作流都会断掉。agent 仍然在终端里运行，但继续工作通常意味着 SSH、tmux attach、远程桌面，或者只能等你回到电脑前。

[IM.codes](https://im.codes) 让这些会话在手機或網頁上也始终可达：打开终端、检查文件和 Git 變更、在其他设备上預覽 localhost、在任务完成时收到通知，并继续调度多个 agent。

它不是另一个 AI IDE，也不是普通的遠端終端。它是围绕终端型 coding agent 的消息与控制层。

这是一个个人项目。我自己几乎没写代码——它基本由 [Claude Code](https://github.com/anthropics/claude-code) 构建完成，[Codex](https://github.com/openai/codex) 和 [Gemini CLI](https://github.com/google-gemini/gemini-cli) 也提供了大量贡献。

## 共享代理上下文與記憶

IM.codes 會持續把已完成的代理工作沉澱成可重用記憶，並在後續工作階段中自動回灌這些上下文。

- **保存的是問題 → 解決方案，不是日誌噪音。** 只有最終 `assistant.text` 會進入記憶；串流 delta、tool call、tool result 和中間噪音都會被排除。
- **個人記憶支援可選雲端同步。** 原始與處理後的記憶始終保留在本地；處理後的摘要可以按需同步到使用者級雲端池，在多台裝置之間共享。
- **企業共享上下文可查詢、可檢視。** 團隊可以把經驗發佈到 workspace/project 範圍，在 UI 中查詢、查看統計，而不是把上下文藏在不可見的 prompt 裡。這部分仍在持續開發中，還沒有經過完整的生產級測試。
- **多語言召回。** 本地語意搜尋與基於 pgvector 的伺服器召回使用多語言 embedding，可以跨中英日韓西俄等語言找到相關修復經驗。
- **按訊息與按工作階段啟動自動注入。** 相關歷史會在送出訊息前和 session 啟動時自動注入，並透過 timeline 卡片顯示召回內容、原因、相關性分數、召回次數和最後使用時間。
- **使用者可見、可控。** Shared Context UI 分離 raw events、processed summaries、cloud memory 和 enterprise memory，並提供查詢、預覽、archive/restore 與處理設定控制。

## 受監督執行與 Auto Audit

IM.codes 可對支援的 transport-backed agent session 做逐輪監督，而不是依賴盲目的 auto-continue。

- **按 session 設定 Auto 模式。** 可以為每個 session 單獨設定 `off`、`supervised` 或 `supervised_audit`，而不是對所有會話強制使用同一套策略。
- **在 idle 邊界做完成判定。** 當一輪完成後，IM.codes 會把結果判成 `complete`、`continue` 或 `ask_human`，並把後續 continue prompt 直接送回同一 session。
- **失敗即回退的自動化。** Auto supervision 會保持在 timeline/footer 中可見，使用結構化判定，並在逾時、輸出無效或配置錯誤時把控制權還給你，而不是默默猜測。
- **可選的 audit → rework 閉環。** 在 `supervised_audit` 中，已完成的回合可自動進入審計流程，並在交還控制權前把返工 brief 送回同一 session。
- **全域預設值 + 單 session 覆蓋。** 你可以先設定預設的 supervisor backend/model/timeout，再按需在某個 session 上覆蓋 backend/model/timeout、審計模式和自訂提示詞。
- **理解 IM.codes 原生工作流。** Auto supervision 會把 OpenSpec 工作流、P2P 討論/評審流程，以及 `imcodes send` 式的 agent 協作視為正常下一步，而不是立即停下來要求人工介入。

## 功能

### 遠端終端

可以从任意瀏覽器完整访问 agent 会话终端——无需 SSH、VPN 或端口转发。支持原始终端模式（原生 CLI 体验）与结构化聊天视图（解析工具调用、thinking block 和流式输出）之间切换。实时 PTY 流以 12fps 更新，没有消息条数限制。

### 文件瀏覽与 Git 變更

用树形结构瀏覽项目文件。可以从任意设备上传文件、图片和照片，也可以直接从服务器下载文件。Changes 标签页显示 git status，并给出每个文件彩色的 `+新增` / `-删除` 行数。点击文件可打开悬浮預覽窗口，支持语法高亮、diff 视图和每 5 秒自动刷新。文件瀏覽器还可以固定到侧边栏，并自动跟随当前活动标签的项目目录。

### 本地 Web 預覽

可以在手機、平板或远端瀏覽器上預覽你本机的开发服务器，而无需部署。daemon 会通过安全的 WebSocket 隧道把 `localhost` 流量代理到服务器。HTML 重写和运行时补丁会处理 URL 映射，使链接、fetch 和 WebSocket 都能正常工作。支持通过 WebSocket 隧道实现 HMR / 热更新。不需要公开 URL，也不依赖第三方隧道——流量只在你自己的 IM.codes 服务器中转。

### 行動端、手錶與通知

完整支持移动端，包含生物识别认证和推送通知。Shell 会话在手機上也支持交互式键盘输入（类似 SSH）。子会话預覽卡始终显示最新消息。Toast 通知可直接跳转到对应会话。Apple Watch 支持会话快速檢視、未读计数和快速回复。

### 跨模型稽核與 P2P 討論

單一模型的輸出不應被盲目信任。P2P 討論讓多個 agent——跨不同 provider 和思維風格——在寫程式之前就對同一代碼庫進行協作分析。每輪遵循可自訂的多階段流程，每個 agent 讀取所有前序貢獻並在此基礎上輸出。不同模型捕獲不同類別的問題：一個發現競態條件，另一個指出遺漏的 migration，第三個質疑 API 設計。這種跨 provider 交叉審查能在實現前發現絕大部分問題，大幅減少返工。

內建模式包括 `audit`（結構化 audit → review → plan 流水線）、`review`、`discuss` 和 `brainstorm`，也可以自訂階段序列。側邊欄中的環形進度條會顯示 round / hop 完成情況。支持 Claude Code、Codex、Gemini CLI 和 Qwen，也相容帶 sandbox 的 agent。透過 `@@all(config)` 或 UI 配置參與者、輪次、模式和 P2P 設定。

### 串流 Transport Agents

对 [OpenClaw](https://openclaw.com) 和 [Qwen](https://github.com/QwenLM/qwen-agent) 这类 transport 型 agent，提供原生流式输出支持。这些 agent 通过网络协议（WebSocket 或本地 SDK）连接，而不是通过终端抓取，从而能提供实时 delta 更新、工具调用跟踪和会话恢复。

> **OpenClaw 說明：** `imcodes connect openclaw` 目前只在 macOS 上验证过。

### Agent 到 Agent 通信

agent 可以通过 `imcodes send` 直接互相发送消息。一个会话中的 agent 可以请求另一个兄弟会话去 review 代码、跑测试或协同处理任务——无需用户手动中转。支持按 label、session 名或 agent 类型解析目标。`--reply` 参数会要求对方自动把结果发回。内置了防滥用的保护：深度限制、速率限制和广播上限。

```bash
imcodes send "Plan" "review the changes in src/api.ts"
imcodes send "Cx" "run tests" --reply
imcodes send --all "migration complete, check your end"
```

除了 agent-to-agent 聊天，你还可以使用 `script` 会话构建自定义自动化。一个运行在 script 会话中的 Python 脚本可以调用 `imcodes send`，根据任意外部事件触发 agent：

```python
# monitor.py — watch a log file, trigger agent when errors appear
import subprocess, time

while True:
    with open("/var/log/app.log") as f:
        for line in f:
            if "ERROR" in line:
                subprocess.run([
                    "imcodes", "send", "Claude",
                    f"Fix this error and write the patch to /tmp/fix.patch:
{line}"
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

適用場景包括：日志监控自动修复、Webhook 触发代码评审、CI 失败自动诊断、定时数据管道检查，以及需要把结果写入指定文件供人工审批的自定义工作流。

### @ 选择器——智慧 Agent 與檔案選擇

输入 `@` 搜索项目文件，输入 `@@` 选择 agent 用于 P2P 分发。`@@all(config)` 会按照当前会话保存的 P2P 设置（模式、轮数、参与者）发送给所有已配置 agent。通过 `@@all+` 可以自定义轮数。前端只负责选择，具体展开由 daemon 通过结构化 WS 路由完成。

### 多伺服器、多會話管理

你可以把多台开发机接到同一个面板里。每台机器运行一个轻量 daemon，通过 tmux 管理本地 agent 会话。你可以在一个界面里檢視所有 server 和 session，并即时启动、停止、重启或切换。Sub-session 允许你在运行中的主会话内部再启动更多 agent 来并行处理任务。支持可拖拽标签、固定和右键菜单。

### Discord 风格侧边栏

支持 server 图标栏快速切换服务器。层级式会话树支持折叠 sub-session、未读消息徽标，以及 agent 完成任务时的 idle 闪烁动画。任意悬浮窗口（文件瀏覽器、仓库页、子会话聊天）都可以固定到侧边栏。语言切换器和构建信息在底部。

### 可固定面板

任何悬浮窗口都可以拖到侧边栏并固定为常驻面板。支持文件瀏覽器、仓库页面、子会话聊天和终端视图。面板可调整大小、通过服务器同步到多设备，并在重连后自动恢复。底层是通用注册机制，新面板类型只需在一个文件里注册。

### 倉庫看板

可以直接在应用里檢視 issue、pull request、branch、commit 和 CI/CD 运行状态。后台静默刷新，不会出现下拉刷新抖动。CI 状态自动轮询（运行中每 10 秒，否则每 15 秒）。仓库页面也可以固定到侧边栏，常驻显示。

### 定時任務（Cron）

支持以 cron 风格自动化重复性的 agent 工作流。你可以创建定時任務，按时间表向某个 session 发送命令，或触发多 agent 的 P2P 讨论。提供常见周期的可视化 cron 选择器、时区感知调度，以及用于调试的“立即运行”。执行历史支持展开檢視详情，点击任何记录都可以跳转到目标会话并引用结果继续跟进。还支持跨任务执行列表的 Latest / All 模式和多服务器筛选。

### 跨裝置同步

标签顺序、固定标签和固定侧边栏面板会通过服务器偏好 API 在多设备之间同步。采用写穿缓存模式：本地 localStorage 用于即时渲染，服务器端使用防抖 PUT 以保证跨设备一致性。通过带时间戳的 payload 解决冲突。设备特有状态（侧边栏宽度、面板高度、视图模式）仍然保留在本地。

### 国际化

支持 7 种语言：English、簡體中文、繁體中文、Español、Русский、日本語、한국어。侧边栏底部有语言切换器。所有用户可见字符串都通过 i18n key 管理。

### OTA 更新

daemon 可以通过 npm 自升級。也可以从 Web UI 为单台设备或全部设备触发升級。

## IM.codes 不是什么

- 不是另一个 AI IDE
- 不是聊天壳子
- 不只是遠端終端客户端
- 不是 Claude Code、Codex、Gemini CLI、OpenClaw 或 Qwen 的替代品
- 它是围绕这些工具的消息与控制层

## 架构

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

Daemon 运行在你的开发机上，通过 tmux 管理进程型 agent，会通过网络协议管理 transport 型 agent（例如 OpenClaw gateway）。Agent 之间可以用 `imcodes send` 互相通信。Server 负责在你的设备与 daemon 之间中转连接。所有数据都留在你自己的基础设施里。

## 安裝

```bash
npm install -g imcodes
```

## 快速開始

> **強烈建議自行託管。** 共享实例 `app.im.codes` 只用于测试，没有可用性保证，可能会被限流，也可能成为攻击目标。这是个人项目，没有商业支持。除了评估之外，建议部署到你自己的基础设施。

你可以用 [app.im.codes](https://app.im.codes) 做体验，或者在正式使用时自行部署。

```bash
imcodes bind https://app.im.codes/bind/<api-key>
```

这条命令会把你的机器绑定到 IM.codes，启动 daemon，把它注册成系统服务，并让这台机器出现在網頁和移动端面板里。

### OpenClaw 连接

如果本机正在运行 OpenClaw，可以在 daemon 所在机器上把 IM.codes 连接到 OpenClaw gateway：

```bash
imcodes connect openclaw
```

这条命令会做以下事情：

- 默认连接到 `ws://127.0.0.1:18789`
- 自动复用 `~/.openclaw/openclaw.json` 中的 OpenClaw gateway token
- 把 OpenClaw 的主会话和子会话同步到 IM.codes，显示为 transport-backed session / sub-session
- 把 IM.codes 侧的连接配置保存到 `~/.imcodes/openclaw.json`
- 重启 daemon，使 OpenClaw transport 会话能自动重连

常见变体：

```bash
imcodes connect openclaw --url ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=... imcodes connect openclaw
imcodes connect openclaw --url wss://gateway.example.com
```

注意：

- 远程的非 TLS `ws://` 地址需要加 `--insecure`
- 可以通过 `imcodes disconnect openclaw` 删除保存的配置并断开连接
- 这条流程目前只在 macOS 上测试过

## 自行託管

### 一鍵部署

在同一台机器上部署 server + daemon。需要 Docker，以及一个 DNS 已指向服务器的域名。

```bash
npm install -g imcodes
mkdir imcodes && cd imcodes
imcodes setup --domain imc.example.com
```

这条命令会自动生成全部配置，启动 PostgreSQL + server + Caddy（自动 HTTPS），创建管理员账户，并绑定本机 daemon。最后会打印出凭据。

如果要连接更多机器：

```bash
npm install -g imcodes
imcodes bind https://imc.example.com/bind/<api-key>
```

### 手動部署

如果你希望手动配置：

```bash
git clone https://github.com/im4codes/imcodes.git && cd imcodes
./gen-env.sh imc.example.com        # generates .env with random secrets, prints admin password
docker compose up -d
```

產生的 `docker-compose.yml` 已經預設使用 `pgvector/pgvector:pg16` 作為 PostgreSQL 映像。

然后访问 `https://your-domain`，使用 `admin` 和打印出来的密码登录。之后使用 `imcodes bind` 绑定你的开发机。

## Windows（实验性）

Windows 通过 [ConPTY](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/) 原生支持（Windows 10+ 内置），不需要 WSL。

### 安裝与绑定（Windows）

```cmd
npm install -g imcodes
imcodes bind https://app.im.codes/bind/<api-key>
```

### 升級（Windows）

```cmd
imcodes upgrade
```

你也可以从網頁面板远程触发升級（会向 daemon 发送 upgrade 命令）。

### 故障排查（Windows）

如果 daemon 在自动升級后停止运行，可以重建启动链：

```cmd
imcodes repair-watchdog
```

这条命令会使用当前的 Node.js 和 imcodes 路径重写 watchdog 脚本和计划任务。适用于 Node.js 版本切换（nvm、fnm）之后，或者 daemon 升級后无法重启的情况。

如果升級后 `imcodes` 提示 “not recognized as internal or external command”，通常是 npm 全局目录没有加入 PATH。可以这样修复：

```cmd
npm prefix -g
```

复制输出路径并把它加入 PATH：

```cmd
setx PATH "<npm-prefix-path>;%PATH%"
```

然后打开一个**新的**终端窗口。

检查 daemon watchdog 日志：

```
%USERPROFILE%\.imcodes\watchdog.log
```

## 需求

- macOS 或 Linux（都已验证）
- **Windows（实验性）**：通过 ConPTY 原生支持（Windows 10+ 内置）。直接 `npm install -g imcodes` 即可，不需要额外软件。WSL 也可用。
- Node.js >= 22
- 终端复用器：[tmux](https://github.com/tmux/tmux)（Linux/macOS）。Windows 使用 ConPTY（自动检测，系统内置）。
- 至少安裝一个 AI coding agent：[Claude Code](https://github.com/anthropics/claude-code)、[Codex](https://github.com/openai/codex)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[OpenClaw](https://openclaw.com) 或 [Qwen](https://github.com/QwenLM/qwen-agent)

## 免责声明

IM.codes 是一个独立开源项目，与 Anthropic、OpenAI、Google、Alibaba、OpenClaw 以及本文提到的其他公司不存在附属、背书或赞助关系。所有产品名、商标和注册商标均归其各自所有者所有。

## 授權條款

[MIT](../LICENSE)

© 2026 [IM.codes](https://im.codes)
