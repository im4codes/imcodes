# Cursor Agent / Cursor CLI 接入方案

- 设计时间：2026-04-03
- 官方安装入口：`https://cursor.com/install`
- 本地研究目录：`/tmp/cursor-research`
- 相关产物：
  - installer: `/tmp/cursor-research/cursor-cli-artifacts/install.sh`
  - 隔离安装 HOME: `/tmp/cursor-research/home`
  - 官方公开仓库: `/tmp/cursor-research/cursor-repo`
- 目标：为 IM.codes 设计一套 **稳定、可恢复、可诊断、兼容现有 tmux/session-manager 架构** 的 Cursor Agent 接入方案

## 结论

**Cursor 应该优先接成新的 local subprocess transport provider；tmux/wezterm process driver 作为 fallback / interactive mode 保留。**

原因很直接：

1. 官方暴露的是一个 **本地 CLI agent**，而不是像 Qwen 那样明确面向外部集成的 SDK/stream protocol
2. CLI 原生支持：
   - 交互模式
   - `--resume [chatId]`
   - `--continue`
   - `create-chat`
   - `--print --output-format json|stream-json`
3. 但它**没有公开、稳定、文档化的外部 provider API** 可直接嵌进 IM.codes 的 transport runtime
4. IM.codes 现有架构已经非常适合这类工具：
   - `src/agent/drivers/*`
   - `src/agent/session-manager.ts`
   - `src/agent/tmux.ts`
   - `src/store/session-store.ts`

所以 V1 最合理的路线是：

- 新增 transport provider：`cursor`（local subprocess）
- 每轮请求使用 `agent --print --output-format stream-json`
- 启动前调用 `agent create-chat` 拿到 `cursorSessionId`
- 后续轮次统一走 `agent --resume <chatId>`
- 解析结构化事件：`system` / `user` / `thinking` / `assistant` / `tool_call` / `result`
- 保留 `CursorDriver` 作为后续 tmux 交互 fallback

**根据 2026-04-03 的本机实测，Cursor 已经有足够证据优先走 transport，而不是先做 tmux-only 集成。**

---

## 1. 研究结论与证据

## 1.1 官方公开 GitHub 仓库不是 CLI 源码仓

本地 clone：

- `/tmp/cursor-research/cursor-repo`

`README.md` 只有产品入口说明，没有 CLI 源码或 runtime 结构：

- `/tmp/cursor-research/cursor-repo/README.md`

结论：

- `github.com/cursor/cursor` 不能作为 CLI integration source of truth
- 真正可研究对象是：
  - 官方 installer
  - 安装后的 runtime bundle
  - CLI 自身 help / about / 行为实测

## 1.2 官方 installer 明确安装的是 Cursor Agent CLI

从 `/tmp/cursor-research/cursor-cli-artifacts/install.sh` 可确认：

- 标题：`Cursor Agent Installer`
- 下载包：`agent-cli-package.tar.gz`
- 可执行文件：`cursor-agent`
- symlink：
  - `~/.local/bin/agent`
  - `~/.local/bin/cursor-agent`

下载 URL 形态：

- `https://downloads.cursor.com/lab/<version>/<os>/<arch>/agent-cli-package.tar.gz`

这说明它是**独立 agent runtime**，不是编辑器自带命令的薄包装。

## 1.3 CLI 能力轮廓

在隔离 HOME 下安装并实测后，`agent --help` 暴露出这些关键能力：

- 交互启动：`agent [prompt...]`
- headless：`--print`
- 输出格式：`--output-format text|json|stream-json`
- mode：`--mode plan|ask`
- model：`--model <model>`
- resume：`--resume [chatId]`
- continue：`--continue`
- sandbox：`--sandbox enabled|disabled`
- trust：`--trust`
- workspace：`--workspace <path>`
- worktree：`-w, --worktree [name]`
- create-chat：`agent create-chat`
- list/resume chats：`agent ls`, `agent resume`
- auth：`agent login`, `agent logout`, `agent status`, `agent whoami`, `agent about`
- MCP：`agent mcp`

这组能力已经足够支撑 IM.codes 的“process driver + persisted session id”方案。

## 1.4 未登录行为

实测结果：

### `agent about`

可稳定返回：

- CLI Version
- Model
- OS
- Terminal
- Shell
- User Email

未登录时显示：

- `User Email          Not logged in`

### `agent --print ...`

未登录时明确报错：

- `Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.`

### `agent status`

未登录时会先进入：

- `Starting login process...`

随后才显示：

- `Not logged in`

这个行为对自动化不理想，因此：

**启动前诊断/健康检查应优先使用 `agent about`，不要用 `agent status`。**

## 1.5 本地目录与状态文件

隔离安装后可观察到：

- `~/.cursor/cli-config.json`
- `~/.cursor/statsig-cache.json`
- `~/.cursor/projects/...`
- `~/.local/share/cursor-agent/versions/<version>/...`

同时 bundle string 中明确存在：

- `~/.cursor/agent-cli-state.json`
- worktree 相关逻辑
- `CURSOR_API_KEY`
- auth / mcp / workspace 相关逻辑

说明：

1. Cursor CLI 有稳定的用户态本地目录 `~/.cursor`
2. CLI 内部确实维护本地状态
3. 但是公开 help 没直接暴露“chat 数据文件路径”，所以 V1 不要把历史恢复建立在 `.cursor` 内部文件格式反向解析之上

---

## 2. 和 IM.codes 当前架构的匹配关系

## 2.1 IM.codes 现有 process-agent 形态

当前 daemon 里，Claude/Codex/OpenCode/Gemini 都是：

- `src/agent/drivers/base.ts`
- `src/agent/session-manager.ts`
- `src/agent/detect.ts`
- `src/store/session-store.ts`

核心假设是：

1. 通过 shell command 启动 agent
2. 通过 tmux/wezterm 管理进程生命周期
3. 必要时保存 provider-specific session id
4. 通过 pane 状态检测 + 辅助 watcher 实现 UI 状态反馈

Cursor CLI 与这个模型是兼容的。

## 2.2 为什么现在反而更适合 transport provider

最初我倾向于先做 tmux/process，但在本机实测后，结论需要更新。

已经确认的事实：

- `agent create-chat` 可直接返回 chat id
- `agent --print --output-format json` 可稳定返回结构化结果
- `agent --print --output-format stream-json --stream-partial-output` 会输出多事件流
- 事件类型至少包括：
  - `system:init`
  - `user`
  - `thinking:delta`
  - `thinking:completed`
  - `assistant`
  - `tool_call:started`
  - `tool_call:completed`
  - `result:success`
- `--resume <chatId>` 在 headless 模式下可稳定多轮续聊
- 同一 `session_id` 下，第二轮能正确回忆第一轮上下文

这说明 Cursor 已经具备 transport 最核心的四件事：

1. **显式 session identity**：`create-chat` / `resume`
2. **结构化增量输出**：`stream-json`
3. **结构化 tool events**：`tool_call:started/completed`
4. **无需 tmux 的 headless 可执行模型**

所以当前更合理的结论是：

- **V1 优先做 local subprocess transport**
- **tmux process driver 退为 fallback / interactive mode**

这不是因为它有 SDK，而是因为它的 CLI 已经足够像一个可消费的本地协议端点。

---

## 2.3 本机实测摘要（2026-04-03）

实测环境：

- 已安装官方 `agent` CLI
- 已登录真实 Cursor 账号
- workspace: `/Users/k/codes/codedeck/codedeck`

关键结果：

### create-chat

- 可直接返回 UUID chat id
- 未登录时也能返回 id

### json 输出

示例字段：

- `type`
- `subtype`
- `is_error`
- `result`
- `session_id`
- `request_id`
- `usage`

### stream-json 输出

可观察到的事件：

- `system:init`
- `user`
- `thinking:delta`
- `thinking:completed`
- `assistant`（可分块增量输出）
- `tool_call:started`
- `tool_call:completed`
- `result:success`

### resume 多轮验证

在同一个 `chatId` 下：

1. 第一轮：要求记住 codeword `BANANA`，返回 `STORED`
2. 第二轮：询问 codeword，返回 `BANANA`

这说明 headless transport 路径已经支持稳定的多轮 session continuity。

### 已知 caveat

- `result` 字段不总是“干净最终答案”，有时会混入解释文本
- transport 层更应以 `assistant` 事件流为主，`result` 为补充 summary
- `thinking` 默认会暴露，需要 IM.codes 侧决定是否展示/存储

## 3. V1 接入目标

V1 只做四件事：

1. 能把 Cursor 当成一个新 agent type 启动起来
2. 能稳定恢复到指定 chat/session
3. 能在 IM.codes UI 里看到运行/空闲/错误
4. 能给用户明确的“未登录/未安装/认证失败”诊断

V1 **不做**：

- 不解析 `.cursor` 内部 chat 文件格式
- 不做 Cursor 专属 timeline watcher
- 不做 MCP 管理 UI
- 不做工作区/worktree 管理 UI
- 不做 transport 化

---

## 4. 具体设计

## 4.1 新 agent type

在 `src/agent/detect.ts` 中扩展：

### ProcessAgent

从：

- `'claude-code' | 'codex' | 'opencode' | 'shell' | 'script' | 'gemini'`

改为：

- `'claude-code' | 'codex' | 'opencode' | 'shell' | 'script' | 'gemini' | 'cursor'`

并同步更新：

- `PROCESS_AGENTS`
- 所有 agent type 校验点
- server/web 侧 agent type 列表
- sub-session 类型白名单
- 新建 session / project 的 selector

注意：这类共享字符串必须先搜索 `shared/`，若已有常量模块应复用；若没有，再补共享常量。

## 4.2 session-store 扩展

在 `src/store/session-store.ts` 增加：

- `cursorSessionId?: string`
- `cursorModel?: string`（可选，若后续需要 UI 展示或 deterministic resume）

语义：

- `cursorSessionId` 对应 Cursor 的 `chatId`
- 新建会话后持久化
- 恢复时用 `agent --resume <chatId>`

这是最关键的数据持久化点。

## 4.3 LaunchOptions 扩展

在 `src/agent/drivers/base.ts` 的 `LaunchOptions` 中增加：

- `cursorSessionId?: string`
- `cursorModel?: string`
- `cursorMode?: 'plan' | 'ask'`
- `cursorSandbox?: 'enabled' | 'disabled'`

V1 至少需要：

- `cursorSessionId`
- `cursorModel`

## 4.4 新增 `CursorProvider`（主路径）

新增文件建议：

- `src/agent/providers/cursor.ts`

形态：

- provider id: `cursor`
- runtime type: `transport`
- connection mode: `local-subprocess`（命名可按你现有 provider 体系调整）

核心流程：

1. `createSession()`
   - 调 `agent create-chat`
   - 持久化 `cursorSessionId`
2. `send(sessionId, prompt)`
   - 启动子进程：
     - `agent --print --output-format stream-json --stream-partial-output --trust --workspace <cwd> --resume <sessionId> <prompt>`
3. 解析 stdout 每行 JSON
4. 映射到 IM.codes timeline / delta / tool event / complete / error
5. 进程结束即本轮 request 结束，但 session 通过 `cursorSessionId` 延续

这本质上是 **stateless worker process + stateful remote/local chat session**。

## 4.5 新增 `CursorDriver`（fallback）

新增文件：

- `src/agent/drivers/cursor.ts`

推荐行为：

### `type`

- `readonly type = 'cursor'`

### `buildLaunchCommand(...)`

V1 推荐默认启动命令：

```bash
cd <cwd> && agent --workspace <cwd>
```

更稳的版本：

```bash
cd <cwd> && agent --workspace <cwd> --trust
```

但是否默认加 `--trust`，要看你是否接受“跳过信任提示”的安全语义。建议：

- **主会话默认不加 `--trust`**，先保守
- 如果后续实测每次都会弹 trust prompt，再加启动后自动 dismiss 或加可配置开关

### `buildResumeCommand(...)`

有 `cursorSessionId` 时：

```bash
cd <cwd> && agent --workspace <cwd> --resume <cursorSessionId>
```

没有 `cursorSessionId` 时：

```bash
cd <cwd> && agent --workspace <cwd> --continue || agent --workspace <cwd>
```

但这只是 fallback。**正式实现应该尽量依赖持久化的 `cursorSessionId`，不要依赖 `--continue`。**

### `model`

如果配置了 `cursorModel`：

```bash
agent --workspace <cwd> --model <model>
```

### `sandbox`

如果要映射 IM.codes 的“危险全权限”语义，可考虑：

- 默认不显式传 `--sandbox`
- 或加一个配置项，把“full access”映射成 `--sandbox disabled`

V1 先不强耦合，避免误判 Cursor 的安全模型。

## 4.6 `getDriver()` 接线

在 `src/agent/session-manager.ts` 的 `getDriver(type)` 中：

- `case 'cursor': return new CursorDriver();`

并同步处理：

- `inferAgentTypeFromPane()`
  - 启动命令里命中 `\bagent\b` 或 `\bcursor-agent\b` 时返回 `cursor`

这里要谨慎：

- `agent` 这个命令名过于泛化
- 不能只靠 `\bagent\b` 判断，否则可能误伤别的命令

更稳的做法：

1. 优先命中 `cursor-agent`
2. 对 `agent` 只在命令路径指向 `~/.local/bin/agent` 或包含 `cursor-agent` symlink 信息时识别为 Cursor
3. 或者在 store 里持久化已知 type，pane 推断只作为 fallback

结论：

- **不要粗暴用字符串 `agent` 判定 agentType**
- pane 推断里优先识别 `cursor-agent`
- 对 `agent` 用保守 fallback 规则

---

## 5. 启动前诊断设计

这是 Cursor 接入里最需要补的一层。

## 5.1 为什么必须做启动前诊断

实测表明：

- 未登录时，`agent --print ...` 直接失败
- 未登录时，`agent status` 还会尝试触发登录流程

如果不做预检，用户从 IM.codes 里看到的只会是：

- pane 卡住
- session 状态不明确
- 启动失败原因不清楚

这会比现有 Claude/Codex 体验差很多。

## 5.2 推荐诊断命令

使用：

```bash
agent about
```

原因：

- 输出稳定
- 不会像 `status` 那样卡在登录流程
- 可直接拿到：
  - version
  - terminal
  - shell
  - user email / `Not logged in`

## 5.3 诊断流程

在启动 Cursor session 前：

1. `which agent || which cursor-agent`
   - 不存在：报 “Cursor Agent not installed”
2. 执行 `agent about`
   - 失败：报 “Cursor Agent probe failed”
3. 解析 `User Email`
   - `Not logged in`：报 “Cursor Agent authentication required”
4. 成功后再真正启动 tmux session

## 5.4 错误文案要能落到 UI

建议统一成 machine-readable 错误码：

- `cursor.not_installed`
- `cursor.not_logged_in`
- `cursor.probe_failed`
- `cursor.launch_failed`

然后 web 侧 i18n 显示：

- 未安装：请运行 `curl -fsSL https://cursor.com/install | bash`
- 未登录：请运行 `agent login` 或设置 `CURSOR_API_KEY`

---

## 6. 如何拿到并持久化 `cursorSessionId`

这是 V1 的真正难点。

## 6.1 可用能力

Cursor CLI 明确提供：

- `agent create-chat`
- `agent --resume [chatId]`
- `agent ls`
- `agent resume`

这说明 chat/session id 是一等概念。

## 6.2 最优方案：启动前预建 chat

推荐做法：

1. 在 daemon 启动 Cursor session 前，先执行：

```bash
agent create-chat
```

2. 拿到返回的 chatId
3. 持久化到 `SessionRecord.cursorSessionId`
4. 真正启动 tmux session 时使用：

```bash
agent --workspace <cwd> --resume <chatId>
```

这样有几个好处：

- session identity 在启动前就确定
- 不需要从 TUI 屏幕里猜 chat id
- 和 Claude/Codex/Gemini 的“持久化 provider session id”模式一致

## 6.3 为什么不用“启动后再发现 id”

因为那样要么：

- 解析终端文本
- 要么解析 `.cursor` 内部状态文件
- 要么依赖 `agent ls` 的最近会话推断

这些都不稳。

**Cursor 明明已经给了 `create-chat`，就应该前置生成。**

## 6.4 create-chat 的使用约束

这里要实测确认两点，但从命令设计看大概率成立：

1. `create-chat` 是否要求已登录
2. 是否会在当前 workspace 语义下创建 chat

若它不接受 `--workspace`，V1 也仍然可用，因为：

- IM.codes 主要需要的是一个可恢复的 chat id
- workspace 仍由正式启动命令里的 `--workspace <cwd>` 绑定

实施前要补一个小验证脚本，确认：

- `agent create-chat` 输出是否只有 chat id
- `agent --resume <chatId> --workspace <cwd>` 是否稳定

---

## 7. 状态检测方案

V1 不做 Cursor 专属 transcript watcher，所以状态主要靠 pane 检测。

## 7.1 第一阶段：独立 Cursor 检测器

在 `src/agent/detect.ts` 中增加 Cursor 分支，而不是先复用 Codex/Claude。

原因：

- Cursor 虽然也是 terminal agent，但 prompt/spinner/overlay 未必与现有三者一致
- 直接复用 Codex 检测会制造假 idle / 假 thinking

## 7.2 推荐初始策略

先保守：

- prompt 以启动后的实机捕获为准
- 在没有足够样本前，宁愿多判 `thinking`，不要误判 `idle`

实施步骤：

1. 本地真实跑一个已登录 Cursor session
2. 捕获以下场景 pane：
   - 空闲 prompt
   - 正在思考
   - 正在调用工具
   - 请求权限/确认
   - 启动 trust/login/update 提示
3. 基于样本加模式

## 7.3 V1 可接受退化

如果早期没法把 `tool_running` / `thinking` 分得很细，也可以先做到：

- `idle`
- `running`
- `error`

但不能误把工作中判成 idle。

---

## 8. 启动后自动处理的 prompt

从现有 agent 经验看，Cursor 很可能也有几类启动 prompt：

- workspace trust
- login/auth related notices
- update available
- sandbox/approval 提示

但目前我们还没拿到已登录态的完整 TUI 样本，所以：

- V1 **不要像 Claude Code 那样上来就写一堆 auto-dismiss**
- V1 只做：
  - 安装前 probe
  - 登录前 probe
  - 启动失败可见化

等拿到真实 pane 样本，再补 `postLaunch()` 自动处理。

---

## 9. Web / Server 侧改造点

## 9.1 agent type 列表

需要把 `cursor` 加到所有 agent type selector / allowlist：

至少包括：

- `server/src/routes/sub-sessions.ts`
- `web/src/pages/AddProject.tsx`
- `web/src/pages/AutoFixControls.tsx`
- `web/src/components/NewSessionDialog` 相关测试/实现
- 其他硬编码 agent type 列表

## 9.2 UI 命名

UI 展示建议：

- internal type: `cursor`
- display label: `Cursor`

不要用：

- `cursor-agent`
- `agent`

因为：

- `agent` 太泛
- `cursor-agent` 是二进制名，不适合 UI

## 9.3 会话设置

如后续支持模型/模式配置，可在 session settings 或新建项目时增加：

- model
- mode (`plan` / `ask`)
- sandbox preference

V1 可先不暴露 UI，仅支持默认值。

---

## 10. 推荐实施顺序

## Phase 1 — local transport 最小闭环

1. `AgentType` / provider registry 增加 `cursor`
2. 新增 `CursorProvider`
3. 接入 `agent about` 预检
4. 接入 `agent create-chat`
5. 保存 `cursorSessionId`
6. 每轮调用 `agent --print --output-format stream-json ... --resume <chatId>`
7. 映射基础事件：
   - `system:init`
   - `assistant`
   - `result:success`
   - error

交付标准：

- 用户能从 IM.codes 创建 Cursor transport session
- 能发一轮消息并看到结构化返回
- 未安装/未登录有明确错误

## Phase 2 — 完整事件映射与多轮恢复

1. 映射 `thinking:*`
2. 映射 `tool_call:*`
3. 验证 `--resume <chatId>` 多轮稳定性
4. daemon 重启后从 store 恢复 `cursorSessionId`

交付标准：

- 多轮会话稳定
- tool call 能进 timeline
- daemon 重启后不丢 Cursor session identity

## Phase 3 — tmux fallback / interactive mode

1. 新增 `CursorDriver`
2. 支持用户显式开一个交互 Cursor pane
3. 作为 transport 之外的手动调试/观察模式

交付标准：

- 用户可选择 interactive Cursor session
- 不影响 transport 主路径

## Phase 4 — 可选增强

1. 更细粒度的 reasoning 展示策略
2. 中断/取消语义验证
3. MCP / worktree / mode UI
4. 如果官方将来提供正式 SDK，再评估切换到底层 SDK

---

## 11. 风险与规避

| 风险 | 影响 | 规避 |
|------|------|------|
| `agent` 命令名太泛 | pane 推断误判 | 优先识别 `cursor-agent`，`agent` 只作保守 fallback |
| 未登录时 CLI 挂在登录流程 | 启动卡住 | 启动前统一走 `agent about` probe |
| `create-chat` 输出格式变化 | session id 获取失败 | 封装单独 parser，并加集成测试/fixture |
| `.cursor` 内部文件结构变化 | 历史读取不稳 | V1 不依赖内部文件格式 |
| trust/sandbox 启动 prompt 未知 | 启动后卡住 | 先不自动 dismiss，先拿真实样本再补 |
| 模型/模式配置没落库 | resume 不一致 | Phase 2 先加 `cursorSessionId`，Phase 3 再决定是否持久化 model/mode |

---

## 12. 需要新增的测试

## 12.1 daemon unit tests

新增：

- `test/agent/cursor-driver.test.ts`

覆盖：

- build fresh launch command
- build resume command with `cursorSessionId`
- model flag 拼接
- workspace/cwd 行为

## 12.2 session-manager tests

覆盖：

- `getDriver('cursor')`
- `inferAgentTypeFromPane()` 对 `cursor-agent` 的识别
- 不误把普通 `agent` 命令识别成 Cursor

## 12.3 preflight / integration tests

新增：

- Cursor probe parser tests
- `agent about` output parser tests
- `create-chat` output parser tests

如果做集成测试，建议用 stub binary，不要求 CI 真装 Cursor：

- 用假 `agent` 可执行文件输出固定文本
- 验证 daemon 对：
  - 未安装
  - 未登录
  - 正常已登录
  - create-chat 成功/失败
  的处理路径

---

## 13. 最终建议

**Cursor V1 应优先按 local subprocess transport 来接。**

真正要做对的核心点变成四件事：

1. **预检**：`agent about`，明确未安装/未登录
2. **稳定 session identity**：`agent create-chat` + 持久化 `cursorSessionId`
3. **结构化事件映射**：消费 `stream-json`，不要只看 `result`
4. **多轮恢复**：统一走 `--resume <chatId>`

这条路线现在的优势是：

- 已经有真实实测支撑，不是猜测
- 比 tmux 文本解析更结构化
- 有 tool event，可直接进 timeline
- 后续仍可保留 tmux interactive fallback

---

## 14. 本次研究输入清单

本地研究使用的主要输入：

- `/tmp/cursor-research/cursor-cli-artifacts/install.sh`
- `/tmp/cursor-research/home/.local/share/cursor-agent/versions/2026.03.30-a5d3e17/*`
- `/tmp/cursor-research/home/.local/bin/agent --help`
- `/tmp/cursor-research/home/.local/bin/agent about`
- `/tmp/cursor-research/home/.local/bin/agent create-chat --help`
- `/tmp/cursor-research/home/.local/bin/agent resume --help`
- `/tmp/cursor-research/home/.local/bin/agent ls --help`
- `/tmp/cursor-research/cursor-repo/README.md`
- IM.codes 当前代码：
  - `src/agent/detect.ts`
  - `src/agent/drivers/base.ts`
  - `src/agent/drivers/claude-code.ts`
  - `src/agent/drivers/codex.ts`
  - `src/agent/session-manager.ts`
  - `src/store/session-store.ts`
