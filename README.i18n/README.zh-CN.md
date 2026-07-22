# [IM.codes](https://im.codes)

[English](../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [한국어](README.ko.md)


**给 AI agent 的 IM。共享记忆、OpenSpec 自动交付、托管 MCP 工具、受监督执行，以及跨模型审计。**

> 三个臭皮匠，顶个诸葛亮。<br>
> 三个诸葛亮，谈笑定阴阳。<br>
> — IM.codes

IM.codes 为 coding agent 提供一套跨 provider 共享的记忆层和托管 MCP 工具面。它会把已完成的工作沉淀成可复用上下文，再把合适的历史注入或召回到后续 session，贯通 [Claude Code](https://github.com/anthropics/claude-code)、[Codex](https://github.com/openai/codex)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、GitHub Copilot、Cursor、OpenCode、[OpenClaw](https://openclaw.com)、[Qwen](https://github.com/QwenLM/qwen-agent) 等，同时提供终端访问、文件浏览、Git 视图、localhost 预览、通知、多 agent 工作流，以及 transport 型 agent 的原生流式输出。OpenSpec 自动交付可以把一个变更从提案/规格审计推进到实现、验证建议、团队审计/返工、自动模块打分和最终质量门控。会话共享也支持围绕实时 agent session 的双人或多人协作编程。内置 Auto supervision 可在每轮完成后判断任务是否完成、是否继续自动执行，并可选进入审计/返工闭环后再把控制权交还给你。内置团队讨论功能，让多个模型相互审阅对方的方案和实现，能有效减少单模型的遗漏、盲点和偏差。

> **说明：** 本文件是中文翻译版。**英文 README（`../README.md`）是规范版本。** 若内容存在差异，以英文版为准。

支持多个 agent 通过 CLI 和 SDK 两种方式接入。

## 截图

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

### 手机

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


手表支持会话快速查看、未读计数、推送通知，以及直接在手腕上快速回复。

## 下载

<a href="https://apps.apple.com/us/app/im-codes/id6761014424"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40" alt="Download on the App Store" /></a>

支持 iPhone、iPad 和 Apple Watch。也可以通过 [Web App](https://app.im.codes) 使用。

## 为什么做这个

当你离开电脑时，大多数 coding-agent 工作流都会断掉。agent 仍然在终端里运行，但继续工作通常意味着 SSH、tmux attach、远程桌面，或者只能等你回到电脑前。

这只是问题的一半。复杂 coding-agent 工作还需要更稳的判断：单个模型容易陷入定式、漏掉问题，复杂任务上的输出也可能不稳定。切换 provider 可以带来新视角，但如果没有共享上下文，也容易丢掉前文和项目记忆。

[IM.codes](https://im.codes) 同时解决这两类问题。它让这些会话在手机或网页上始终可达：打开终端、检查文件和 Git 变更、在其他设备上预览 localhost、在任务完成时收到通知、邀请另一个人进入同一会话或服务器，并继续调度多个 agent。它也把下文的「共享代理上下文与记忆」和「跨模型审计与团队讨论」连在一起：可持久召回的是已完成工作的摘要记忆，团队讨论则是在代码落地前进行的结构化跨模型审阅。它不能让输出完美，但能减少单模型盲点，让复杂工作在更多审阅下更容易收敛。

它不是另一个 AI IDE，也不是普通的远程终端。它是围绕终端型 coding agent 的消息、记忆与审阅层。

## OpenSpec 自动交付

对于基于 OpenSpec 的变更，Auto Deliver 会把一个 change 目录变成端到端的受监督交付运行：提案/规格审计、实现、验证、团队审计、自动模块打分、返工门控和可见的最终交接。

- **一键启动变更流水线。** 从 transport 型 coding session 上启动，IM.codes 会解析所属主会话、锁定 Team 通道防止冲突运行、读取 `tasks.md`，并在 UI 中保持实时运行状态。
- **实现前先做规格审计。** 可选的提案/规格 audit-repair 使用常规 Team 流程（默认 `audit>review>plan`），并读取权威 JSON，而不是盲信聊天摘要。
- **按任务驱动实现循环。** daemon 会把聚焦的实现 prompt 发回同一 session，只处理该 OpenSpec 变更，跟踪 checked/unchecked 任务，并展示从项目 manifest 中发现的安全验证命令候选。
- **自动模块打分。** 每轮审计都会对 `spec`、`tasks`、`implementation`、`tests`、`risk` 给出结构化评分，证据和摘要显示在运行详情里，而不是埋在聊天文本中。
- **实现审计与返工门控。** 最终带评分的 `PASS`、`REWORK` 或 `BLOCKED` 判定会决定运行是通过、在限制内继续修复，还是需要人工决策。
- **失败即回退，用户保留最终控制权。** 审计输出无效、时间/次数耗尽、人工干预、Team 状态不兼容或任务不可读时，Auto Deliver 会要求人工输入。它不会 stage、commit 或 push 代码。

## 协作编程

把当前标签页、子会话或整台 source server 分享给其他用户。`viewer` 适合只读 review；`participant` 可以向覆盖范围内的会话发送 prompt。Shared message 会标注真人 actor，权限可在 UI 中降级或撤销。

## 共享代理上下文与记忆

IM.codes 会持续把已完成的代理工作沉淀成可复用记忆，并在后续会话中自动回灌这些上下文。

- **保存的是问题 → 解决方案，不是日志噪音。** 只有最终 `assistant.text` 会进入记忆；流式 delta、tool call、tool result 和中间噪音都会被排除。
- **个人记忆支持可选云同步。** 原始和处理后的记忆始终保留在本地；处理后的摘要可以按需同步到用户级云端池，在多台设备之间共享。
- **企业共享上下文可查询、可检查。** 团队可以把经验发布到 workspace/project 作用域，在 UI 里查询、查看统计，而不是把上下文藏在不可见的 prompt 里。这部分仍在持续开发中，还没有经过完整的生产级测试。
- **多语言召回。** 本地语义搜索和基于 pgvector 的服务端召回使用多语言 embedding，可以跨中英日韩西俄等语言找到相关修复经验。
- **按消息和按会话启动自动注入。** 相关历史会在发送消息前和 session 启动时自动注入，并通过 timeline 卡片显示召回内容、原因、相关性分数、召回次数和最后使用时间。
- **用户可见、可控。** Shared Context UI 分离 raw events、processed summaries、cloud memory 和 enterprise memory，并提供查询、预览、archive/restore 与处理配置控制。

## 托管 MCP 工具

IM.codes 会向支持的 SDK 型 provider 暴露由 daemon 管理的 stdio MCP server。Agent 可以使用同一个运行时作用域内的工具面完成记忆、agent-to-agent 消息和定时 follow-up，而不需要接触原始认证 token 或临时 shell 命令。

- **记忆召回与来源。** `search_memory` 会在当前调用者绑定的记忆命名空间中搜索过往工作、项目历史、决策、偏好、bug、commit、部署和既往讨论上下文。`list_memory_summaries` 可无查询拉取最近紧凑摘要。结果包含紧凑 ref 和 `projectionId`；当模型需要精确的历史指令、bug 细节、commit/部署上下文或来源证据时，`get_memory_sources` 可把相关命中展开成来源片段。
- **记忆写入。** `save_observation` 把有用事实、决策或实现备注保存为用户私有的候选记忆；`save_preference` 通过显式偏好路径保存稳定的用户偏好。
- **Agent 消息。** `send_list_targets` 列出当前项目内的兄弟会话，`send_message` 通过同一套受保护的 `imcodes send` 管线发送有作用域的消息、可选文件路径引用、回复请求或广播。
- **Cron 调度。** `cron_create`、`cron_list`、`cron_update` 和 `cron_delete` 管理未来的结构化发送任务，可用于提醒、周期性检查、委托 review 或定时团队 follow-up，并支持目标、session、project、过期时间和时区字段。
- **运行时身份与安全。** 工具调用在运行时绑定到当前 IM.codes session、project、user 和 server。Agent 不能伪造 namespace、user、server、token 或路由字段；记忆、Send 和 Cron 都同时受底层功能门控和 MCP kill-switch 保护。
- **运维可见性。** Shared Context UI 会按托管 provider 显示 MCP 就绪状态、工具族门控、降级原因、更新时间和 daemon 脱敏后的最近工具调用，方便确认模型是否真的可用 Memory、Send 和 Cron。

## 受监督执行与 Auto Audit

IM.codes 可用你自己的 supervisor 提示词对支持的 agent session 做逐轮驱动 —— 每一轮 idle 边界上结构化判定是 auto-continue、交还给你，还是触发一次 audit 闭环，而不是让你每轮手动打 "continue"。

- **按 session 配置 Auto 模式。** 可以为每个 session 单独设置 `off`、`supervised` 或 `supervised_audit`，而不是对所有会话强行使用同一套策略。
- **在 idle 边界做完成判定。** 当一轮完成后，IM.codes 会把结果判成 `complete`、`continue` 或 `ask_human`，并把后续 continue prompt 直接发回同一 session。
- **失败即回退的自动化。** Auto supervision 会保持在 timeline/footer 中可见，使用结构化判定，并在超时、输出无效或配置错误时把控制权还给你，而不是默默猜测。
- **可选的 audit → rework 闭环。** 在 `supervised_audit` 中，已完成的回合可自动进入审计流程，并在交还控制权前把返工 brief 发回同一 session。
- **全局默认值 + 单 session 覆盖。** 你可以先设置默认的 supervisor backend/model/timeout，再按需在某个 session 上覆盖 backend/model/timeout、审计模式和自定义提示词。
- **理解 IM.codes 原生工作流。** Auto supervision 会把 OpenSpec 工作流、团队讨论/评审流程，以及 `imcodes send` 式的 agent 协作视为正常下一步，而不是立即停下来要求人工介入。

## 功能

### 私有别名

保存归当前用户所有的可复用文本片段，在输入框键入 `;` 搜索，或直接插入 `;;(name)` 标记。消息里会保留可见标记，IM.codes 在带外解析并把真实值交给 agent。Agent 也可通过托管 MCP 工具创建、搜索、编辑和解析别名；批量列表只暴露元数据，避免一次调用把所有别名值送进模型上下文。

### 受控节点

把另一台机器注册为受限的受控节点，而不必把它变成完整的 IM.codes source server。输入 `^` 自动补全目标，或直接插入 `^^(name)`；获授权的 agent 随后可以在该节点上执行有作用域的远程命令、传输单个文件，或调用类型化的 Computer Use 工具。执行能力由所有者启用并可随时撤销，受控节点不会混入普通 server/session 列表，每台机器也使用独立凭证。下载链接会过期，但新下载的安装包可长期保留并重复用于注册多台机器。

### Computer Use 与浏览器自动化

受支持的 SDK agent 可以通过类型化 Computer Use 工具控制桌面应用。跨平台桌面应用控制集成了 Leo（[iFurySt](https://github.com/iFurySt)）开发、采用 [MIT 许可证](https://github.com/iFurySt/open-codex-computer-use/blob/main/LICENSE)的 [Open Computer Use](https://github.com/iFurySt/open-codex-computer-use)；这里明确感谢该项目提供的这项集成能力。

浏览器自动化则是 IM.codes 独立实现的功能，直接使用 Chrome DevTools Protocol（CDP）：agent 可打开、检查、导航、点击、填写和执行页面脚本，默认返回结构化文本，仅在请求时附带截图。托管浏览器还会暴露仅限本机回环访问的 CDP 端点，方便本机 Python 或 Node 脚本复用同一个浏览器实例完成复杂任务，而无需再启动一个浏览器。

### 远程终端

可以从任意浏览器完整访问 agent 会话终端——无需 SSH、VPN 或端口转发。支持原始终端模式（原生 CLI 体验）与结构化聊天视图（解析工具调用、thinking block 和流式输出）之间切换。实时 PTY 流以 12fps 更新，没有消息条数限制。

### 文件浏览与 Git 变更

用树形结构浏览项目文件。可以从任意设备上传文件、图片和照片，也可以直接从服务器下载文件。Changes 标签页显示 git status，并给出每个文件彩色的 `+新增` / `-删除` 行数。点击文件可打开悬浮预览窗口，支持语法高亮、diff 视图、HTML 快速渲染预览和每 5 秒自动刷新。聊天里解析到的本地文件链接也有快捷操作：HTML 文件可打开安全渲染预览，本地图片路径会直接原地显示缩略图，点击后悬浮放大。文件浏览器还可以固定到侧边栏，并自动跟随当前活动标签的项目目录。

### 本地 Web 预览

可以在手机、平板或远端浏览器上预览你本机的开发服务器，而无需部署。daemon 会通过安全的 WebSocket 隧道把 `localhost` 流量代理到服务器。HTML 重写和运行时补丁会处理 URL 映射，使链接、fetch 和 WebSocket 都能正常工作。支持通过 WebSocket 隧道实现 HMR / 热更新。不需要公开 URL，也不依赖第三方隧道——流量只在你自己的 IM.codes 服务器中转。

### 移动端、手表与通知

完整支持移动端，包含生物识别认证和推送通知。Shell 会话在手机上也支持交互式键盘输入（类似 SSH）。子会话预览卡始终显示最新消息。Toast 通知可直接跳转到对应会话。Apple Watch 支持会话快速查看、未读计数和快速回复。

### OpenSpec 自动交付

用结构化流水线交付一个规格驱动变更：提案/规格审计、实现 prompt、manifest 感知的验证建议、团队审计/返工、对 spec/tasks/implementation/tests/risk 的自动模块打分，以及失败即回退的最终交接。运行条会显示阶段进度、任务数、审计轮次、证据和终止原因，避免自动化变成不可见的后台代理。

### 协作编程

把实时 session 分享给另一个人做 pair programming，或邀请多人进入有作用域的 server 工作区，并用 viewer/participant 区分权限。

### 跨模型审计与团队讨论

单模型输出不应被盲目信任。团队讨论让多个 agent——跨不同 provider 和思维风格——在写代码之前就对同一代码库进行协作分析。每轮遵循可自定义的多阶段流程，每个 agent 读取所有前序贡献并在此基础上输出。不同模型捕获不同类别的问题：一个发现竞态条件，另一个指出遗漏的 migration，第三个质疑 API 设计。这种跨 provider 交叉审查能在实现前发现单个模型常漏掉的问题，减少返工。

内置模式包括 `audit`（结构化 audit → review → plan 流水线）、`review`、`discuss` 和 `brainstorm`，也可以自定义阶段序列。侧边栏中的环形进度条会显示 round / hop 完成情况。支持 Claude Code、Codex、Gemini CLI 和 Qwen，也兼容带 sandbox 的 agent。通过 `@@all(config)` 或 UI 配置参与者、轮次、模式和团队设置。

### 流式 Transport Agents

对 [OpenClaw](https://openclaw.com) 和 [Qwen](https://github.com/QwenLM/qwen-agent) 这类 transport 型 agent，提供原生流式输出支持。这些 agent 通过网络协议（WebSocket 或本地 SDK）连接，而不是通过终端抓取，从而能提供实时 delta 更新、工具调用跟踪和会话恢复。

> **OpenClaw 说明：** `imcodes connect openclaw` 目前只在 macOS 上验证过。

### 托管 MCP 工具面

支持的 SDK provider 可以自动获得 IM.codes 托管的十工具 MCP 面：记忆搜索/来源查看、观察记录和偏好写入、Scoped Send，以及 Cron 调度。UI 会按 provider 上报 ready/degraded 状态，让你知道某个模型是否真的可用 Memory、Send 和 Cron。

### Agent 到 Agent 通信

agent 可以通过 `imcodes send` 直接互相发送消息。一个会话中的 agent 可以请求另一个兄弟会话去 review 代码、跑测试或协同处理任务——无需用户手动中转。支持按 label、session 名或 agent 类型解析目标。`--reply` 参数会要求对方自动把结果发回。内置了防滥用的保护：深度限制、速率限制和广播上限。

同一条通路也通过 MCP 暴露给 SDK 型 agent：`send_list_targets` 发现有效兄弟目标，`send_message` 发送有作用域的文本、文件引用、回复请求或广播，同时不会暴露原始路由凭证。

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

适用场景包括：日志监控自动修复、Webhook 触发代码评审、CI 失败自动诊断、定时数据管道检查，以及需要把结果写入指定文件供人工审批的自定义工作流。

### @ 选择器——智能 Agent 与文件选择

输入 `@` 搜索项目文件，输入 `@@` 选择 agent 用于团队分发。`@@all(config)` 会按照当前会话保存的 团队设置（模式、轮数、参与者）发送给所有已配置 agent。通过 `@@all+` 可以自定义轮数。前端只负责选择，具体展开由 daemon 通过结构化 WS 路由完成。

### 多服务器、多会话管理

你可以把多台开发机接到同一个面板里。每台机器运行一个轻量 daemon，通过 tmux 管理本地 agent 会话。你可以在一个界面里查看所有 server 和 session，并即时启动、停止、重启或切换。Sub-session 允许你在运行中的主会话内部再启动更多 agent 来并行处理任务。支持可拖拽标签、固定和右键菜单。

### Discord 风格侧边栏

支持 server 图标栏快速切换服务器。层级式会话树支持折叠 sub-session、未读消息徽标，以及 agent 完成任务时的 idle 闪烁动画。任意悬浮窗口（文件浏览器、仓库页、子会话聊天）都可以固定到侧边栏。语言切换器和构建信息在底部。

### 可固定面板

任何悬浮窗口都可以拖到侧边栏并固定为常驻面板。支持文件浏览器、仓库页面、子会话聊天和终端视图。面板可调整大小、通过服务器同步到多设备，并在重连后自动恢复。底层是通用注册机制，新面板类型只需在一个文件里注册。

### 仓库看板

可以直接在应用里查看 issue、pull request、branch、commit 和 CI/CD 运行状态。后台静默刷新，不会出现下拉刷新抖动。CI 状态自动轮询（运行中每 10 秒，否则每 15 秒）。仓库页面也可以固定到侧边栏，常驻显示。

### 定时任务（Cron）

支持以 cron 风格自动化重复性的 agent 工作流。你可以创建定时任务，按时间表向某个 session 发送命令，或触发多 agent 的团队讨论。提供常见周期的可视化 cron 选择器、时区感知调度，以及用于调试的“立即运行”。执行历史支持展开查看详情，点击任何记录都可以跳转到目标会话并引用结果继续跟进。还支持跨任务执行列表的 Latest / All 模式和多服务器筛选。

SDK 型 agent 也可以通过 MCP 使用同一个调度器：`cron_create`、`cron_list`、`cron_update` 和 `cron_delete` 可创建提醒、周期检查、委托 review 或后续 follow-up 的结构化发送任务，并保持绑定在当前项目/session 身份内。

### 跨设备同步

标签顺序、固定标签和固定侧边栏面板会通过服务器偏好 API 在多设备之间同步。采用写穿缓存模式：本地 localStorage 用于即时渲染，服务器端使用防抖 PUT 以保证跨设备一致性。通过带时间戳的 payload 解决冲突。设备特有状态（侧边栏宽度、面板高度、视图模式）仍然保留在本地。

### 国际化

支持 7 种语言：English、简体中文、繁體中文、Español、Русский、日本語、한국어。侧边栏底部有语言切换器。所有用户可见字符串都通过 i18n key 管理。

### OTA 更新

daemon 可以通过 npm 自升级。也可以从 Web UI 为单台设备或全部设备触发升级。

## IM.codes 不是什么

- 不是另一个 AI IDE
- 不是聊天壳子
- 不只是远程终端客户端
- 不是 Claude Code、Codex、Gemini CLI、OpenClaw 或 Qwen 的替代品
- 它是围绕这些工具的消息与控制层

## 架构

```
You (browser / mobile)
        ↓ WebSocket
Server (self-hosted)
        ↓ WebSocket
Daemon (your machine)
        ↓ tmux / transport / managed MCP
AI Agents (Claude Code / Codex / Gemini CLI / OpenClaw)
        ↔ imcodes send (agent-to-agent)
```

Daemon 运行在你的开发机上，通过 tmux 管理进程型 agent，并通过网络协议或本地 SDK 管理 transport 型 agent（例如 Claude Code SDK、Codex SDK、OpenClaw gateway 和 Qwen）。它也负责托管 MCP server，向支持的 SDK provider 暴露运行时作用域内的记忆、Send 和 Cron 工具。Agent 之间可以用 `imcodes send` 互相通信。Server 负责在你的设备与 daemon 之间中转连接。所有数据都留在你自己的基础设施里。

## 安装

```bash
npm install -g imcodes
```

## 快速开始

> **强烈建议自托管。** 共享实例 `app.im.codes` 只用于测试，没有可用性保证，可能会被限流，也可能成为攻击目标。这是个人项目，没有商业支持。除了评估之外，建议部署到你自己的基础设施。

你可以用 [app.im.codes](https://app.im.codes) 做体验，或者在正式使用时自行部署。

```bash
imcodes bind https://app.im.codes/bind/<api-key>
```

这条命令会把你的机器绑定到 IM.codes，启动 daemon，把它注册成系统服务，并让这台机器出现在网页和移动端面板里。

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

## 自托管

### 一键部署

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

### 手动部署

如果你希望手动配置：

```bash
git clone https://github.com/im4codes/imcodes.git && cd imcodes
./gen-env.sh imc.example.com        # generates .env with random secrets, prints admin password
docker compose up -d
```

生成的 `docker-compose.yml` 已经默认使用 `pgvector/pgvector:pg18` 作为 PostgreSQL 镜像。

然后访问 `https://your-domain`，使用 `admin` 和打印出来的密码登录。之后使用 `imcodes bind` 绑定你的开发机。

## Windows（实验性）

Windows 通过 [ConPTY](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/) 原生支持（Windows 10+ 内置），不需要 WSL。

### 安装与绑定（Windows）

```cmd
npm install -g imcodes
imcodes bind https://app.im.codes/bind/<api-key>
```

### 升级（Windows）

```cmd
imcodes upgrade
```

你也可以从网页面板远程触发升级（会向 daemon 发送 upgrade 命令）。

### 故障排查（Windows）

如果 daemon 在自动升级后停止运行，可以重建启动链：

```cmd
imcodes repair-watchdog
```

这条命令会使用当前的 Node.js 和 imcodes 路径重写 watchdog 脚本和计划任务。适用于 Node.js 版本切换（nvm、fnm）之后，或者 daemon 升级后无法重启的情况。

如果升级后 `imcodes` 提示 “not recognized as internal or external command”，通常是 npm 全局目录没有加入 PATH。可以这样修复：

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

## 运行要求

- macOS 或 Linux（都已验证）
- **Windows（实验性）**：通过 ConPTY 原生支持（Windows 10+ 内置）。直接 `npm install -g imcodes` 即可，不需要额外软件。WSL 也可用。
- Node.js >= 22
- 终端复用器：[tmux](https://github.com/tmux/tmux)（Linux/macOS）。Windows 使用 ConPTY（自动检测，系统内置）。
- 至少安装一个 AI coding agent：[Claude Code](https://github.com/anthropics/claude-code)、[Codex](https://github.com/openai/codex)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[OpenClaw](https://openclaw.com) 或 [Qwen](https://github.com/QwenLM/qwen-agent)

## 关于

这是一个个人项目。我自己几乎没写代码——它基本由 [Claude Code](https://github.com/anthropics/claude-code) 构建完成，[Codex](https://github.com/openai/codex) 和 [Gemini CLI](https://github.com/google-gemini/gemini-cli) 也提供了大量贡献。

## 免责声明

IM.codes 是一个独立开源项目，与 Anthropic、OpenAI、Google、Alibaba、OpenClaw 以及本文提到的其他公司不存在附属、背书或赞助关系。所有产品名、商标和注册商标均归其各自所有者所有。

## 许可证

[MIT](../LICENSE)

© 2026 [IM.codes](https://im.codes)
