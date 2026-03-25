# OpenClaw × IM.codes Integration Plan

## 核心定位

OpenClaw 作为 IM.codes 的一种 **agent type** — 和 Claude Code / Codex / Gemini / Shell 同级。

每个 IM.codes session 选 `openclaw` 后，daemon 通过 gateway WS 协议直连 OC agent。用户通过 IM.codes 发消息，OC Pi agent 回复，回复流式推送回来。

```
imcodes bind
imcodes connect openclaw        # 连接本地 OC gateway
# 创建 session 时选 openclaw
# 每个 session = OC 里一个独立 conversation（隔离的 JSONL）
```

## 技术架构

**单组件方案** — daemon 作为 OC gateway WS client 直连，零 OC 侧改动：

```
IM.codes daemon                          OpenClaw Gateway (18789)
  │                                        │
  ├── openclaw provider                    ├── agent RPC method
  │   (TransportProvider 实现)             │   (接收消息，流式返回)
  │                                        │
  │   connect.challenge/connect ────→      │   hello-ok
  │   req: { method: "agent" }  ────→      │   → Pi agent 处理
  │   event: "agent" { delta }  ←────      │   ← 流式 token 回复
  │                                        │
  └── 复用现有聊天界面                      └── Pi agent (LLM runtime)
```

**关键决策**：
- OC 是网络服务，不是 CLI 进程 → **不走 tmux，完全脱离 tmux**
- OC 回复是 chat stream → **复用 IM.codes 现有聊天界面，不需要额外做 UI**
- 引入 **`transport-backed agent`** 通用架构（区别于现有的 `process-backed agent`）
- **不需要 OC extension** — daemon 直连 gateway WS，用 `agent` RPC 发消息（preflight 2026-03-24 验证通过）

### transport-backed agent 架构

**设计原则：一次设计好，分步实现。** 接口现在就按三类 provider 差异设计，避免后续接 MiniMax/CC SDK 时重构。

**两种模式长期并存，不是替代关系：**
- **process-backed（tmux）**：Gemini CLI、OpenCode 只有 CLI 没有 SDK，必须走 tmux。CC/Codex 虽然有 SDK，但很多用户喜欢 CLI 界面。Shell/Script 天然就是 tmux。
- **transport-backed（SDK/API）**：OpenClaw、MiniMax、DeepSeek 等网络服务，以及 CC SDK / Codex SDK 直连模式。

**三类连接模式：**

| 模式 | 代表 | 连接方式 | Session 归属 | 多轮对话 |
|------|------|----------|-------------|---------|
| **persistent** | OpenClaw | 持久 WS | provider 持有 | provider 维护 context |
| **per-request** | MiniMax / DeepSeek | 每次请求新 HTTP | IM.codes 自管 | 需要自己传 history |
| **local-sdk** | CC SDK / Codex SDK | 本地 SDK 调用 | SDK 可能持有部分 | SDK 可能维护 |

### 三层抽象

#### 第一层：SessionRuntime（最优先稳定）

IM.codes 内部统一运行时。决定 session manager、UI、browser relay 怎么看待 agent session。**这层改动最贵，必须一次设计对。**

```typescript
// src/agent/session-runtime.ts
interface SessionRuntime {
  type: 'process' | 'transport';
  send(message: string): Promise<void>;
  getStatus(): AgentStatus;
  kill(): Promise<void>;

  // 可选 — 不是所有 runtime 都支持
  getHistory?(): AgentMessage[];   // per-request provider 需要自管 history
  pause?(): Promise<void>;         // process 有意义，per-request 无意义
  resume?(): Promise<void>;
}
```

#### 第二层：TransportProvider（provider 适配层）

覆盖三类连接模式。核心接口只保留共性最小面，可选能力走 capabilities。

```typescript
// src/agent/transport-provider.ts
interface TransportProvider {
  id: string;

  // 元信息 — 三类 provider 的决定性差异
  connectionMode: 'persistent' | 'per-request' | 'local-sdk';
  sessionOwnership: 'provider' | 'local' | 'shared';

  // 能力声明 — 前端/session manager 按此决定行为
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    approval: boolean;
    sessionRestore: boolean;
    multiTurn: boolean;
    attachments: boolean;
  };

  // 核心（所有 provider 必须实现）
  connect(config: ProviderConfig): Promise<void>;
  disconnect(): Promise<void>;
  send(sessionId: string, message: string, attachments?: Attachment[]): Promise<void>;
  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): void;
  onComplete(cb: (sessionId: string, message: CompleteMessage) => void): void;
  onError(cb: (sessionId: string, error: ProviderError) => void): void;
  createSession(config: SessionConfig): Promise<string>;
  endSession(sessionId: string): Promise<void>;

  // 可选能力（按 capabilities 声明）
  onToolCall?(cb: (sessionId: string, tool: ToolCallEvent) => void): void;
  onApprovalRequest?(cb: (sessionId: string, req: ApprovalRequest) => void): void;
  respondApproval?(sessionId: string, requestId: string, approved: boolean): Promise<void>;
  restoreSession?(sessionId: string): Promise<boolean>;
  listSessions?(): Promise<SessionInfo[]>;
}
```

#### 消息模型

```typescript
// shared/agent-message.ts — transport-backed session 的消息模型
// process-backed（tmux）继续用 binary frame，不强行统一
interface AgentMessage {
  id: string;
  sessionId: string;
  kind: 'text' | 'tool_use' | 'tool_result' | 'system' | 'approval';  // 预留扩展
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  status: 'streaming' | 'complete' | 'error';
  metadata?: Record<string, unknown>;  // provider-specific: model name, finish reason, etc.
}

interface MessageDelta {
  messageId: string;
  type: 'text' | 'tool_use' | 'tool_result';  // 不只是 text
  delta: string;
  role: 'assistant';
  toolUse?: {
    id: string;
    name: string;
    status: 'running' | 'complete' | 'error';
    input?: unknown;
    output?: string;
  };
}
```

#### WsBridge 新增事件

```typescript
// shared/transport-events.ts — 不和 terminal binary frame 混在一起
type TransportEvent =
  | { type: 'chat.delta'; sessionId: string; messageId: string; delta: string; deltaType?: 'text' | 'tool_use' }
  | { type: 'chat.complete'; sessionId: string; messageId: string }
  | { type: 'chat.error'; sessionId: string; error: string; code?: string }
  | { type: 'chat.status'; sessionId: string; status: AgentStatus }
  | { type: 'chat.tool'; sessionId: string; messageId: string; tool: ToolCallEvent }        // 预留
  | { type: 'chat.approval'; sessionId: string; requestId: string; description: string };    // 预留
```

#### 第三层：Provider-specific protocol

OC 的 WS event schema、MiniMax 的 HTTP/SSE、SDK 的 callback — 不强行统一，只要能被第二层适配。

#### 文件结构

```
src/agent/
  session-runtime.ts          — SessionRuntime 接口
  transport-provider.ts       — TransportProvider 接口 + 类型定义
  providers/
    openclaw.ts               — OpenClaw provider（MVP 实现）
    _template.ts              — provider 实现模板（方便后续快速接新 provider）
shared/
  agent-message.ts            — AgentMessage + MessageDelta 类型
  transport-events.ts         — WsBridge 浏览器事件
```

#### AgentType

```typescript
type ProcessAgent = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'shell' | 'script';
type TransportAgent = 'openclaw';  // MVP，后续: 'claude-code-sdk' | 'codex-sdk' | 'minimax' | 'deepseek'
type AgentType = ProcessAgent | TransportAgent;
```

### OpenClaw Provider（`src/agent/providers/openclaw.ts`）

实现 `TransportProvider` 接口，直连 OC gateway WS。

**协议映射**（复用 OC gateway 原生协议，不自建；基于 v2026.3.24 新增 session RPC）：

| IM.codes 操作 | OC 协议 | 说明 |
|--------------|---------|------|
| 连接 | `connect.challenge` → `connect`(token) → `hello-ok` | 标准 gateway 握手 |
| 创建 session | `sessions.create { key, agentId, label, parentSessionKey }` | **v3.24 新增**，替代首次 send 隐式创建 |
| 发消息 | `sessions.send { key, message, thinking, idempotencyKey }` | **v3.24 新增**，替代 `agent` RPC，自动解析 canonicalKey |
| 流式回复 | `event: "agent"` + `stream: "assistant"` + `data.delta` | token 级增量 |
| 开始/结束 | `event: "agent"` + `stream: "lifecycle"` + `phase: "start"/"end"` | 生命周期 |
| 错误 | `event: "agent"` + `stream: "lifecycle"` + `phase: "error"` | 含错误描述 |
| 订阅消息 | `sessions.messages.subscribe { key }` | **v3.24 新增**，实时推送 session 消息事件 |
| 中断 | `sessions.abort { key, runId }` | **v3.24 新增** |
| 心跳 | `event: "tick"` | gateway 原生心跳 |
| 获取历史 | `sessions.get { key, limit }` | **v3.24 新增**，支持 session 恢复 |
| 清理 session | `sessions.reset { key, reason }` | RPC 请求（reason: "new" \| "reset"） |

> **Note**: `agent` RPC 仍可用（向后兼容），但 `sessions.send` 更适合 — 自动处理 canonicalKey 解析、messageSeq 附加、subagent 重激活。

**Session key 策略**:
- **新建 session**: 自动生成 `imcodes:<serverId>:<sessionName>`（避免与 OC 内部 key 冲突）
- **绑定现有 session**: 直接使用 OC 已有的 session key（如 `agent:main:discord:channel:xxx`）
- **自定义 key**: 用户手动输入任意 session key

### Session 绑定与新建

创建 openclaw session（或 sub-session）时，用户有两种模式：

**模式 1：绑定现有 OC session**
- 通过 `sessions.list` RPC 获取 OC session（key, displayName, agentId, updatedAt, tokenUsage）
- **过滤规则**：排除 cron session（key 含 `:cron:`）— cron 是 OC 内部调度，绑定无意义
- 用户从列表中选择一个已有 session
- IM.codes 直接使用该 session key，续接已有上下文
- 典型场景：续接 Discord 频道里的对话、继续一个被中断的 session、接管 agent 主 session

**模式 2：新建 session**
- 调用 `sessions.create` RPC 显式创建（v3.24 新增，支持 `key`, `agentId`, `label`, `parentSessionKey`）
- 自动生成 session key（`imcodes:<serverId>:<sessionName>`）或用户手动指定 key
- 典型场景：创建全新的工作上下文

**Sub-session 同理** — 可以绑定 OC 上一个已有 session 作为 worker，也可以新建。这允许 brain 在 IM.codes 里编排多个已有 OC session。

**需要的 RPC 调用**（v2026.3.24+）:
- `sessions.list` — 列出所有 session（scope: `operator.read`）
- `sessions.create` — 显式创建 session（scope: `operator.write`）
- `sessions.send` — 向 session 发消息（scope: `operator.write`）
- `sessions.get` — 获取 session 消息历史（scope: `operator.read`）
- `sessions.messages.subscribe` — 订阅 session 消息事件推送（scope: `operator.read`）
- `sessions.abort` — 中断当前 run（scope: `operator.write`）
- `sessions.resolve` — 获取单个 session 详情（scope: `operator.read`）
- `sessions.reset` — 清理 session（scope: `operator.admin`，参数用 `key`）

## Connect 命令

`imcodes connect <provider>` 作为统一入口，每个 provider 声明所需配置。OpenClaw 是第一个实例。

```bash
imcodes connect openclaw                    # 自动检测本地 OC (ws://127.0.0.1:18789)
imcodes connect openclaw --url ws://x:18789 # 指定地址
imcodes connect openclaw --token <token>    # 指定 gateway token（远程时使用）
imcodes disconnect openclaw                 # 断开
```

**本地自动认证流程**（零用户输入）：
1. 检测 `~/.openclaw/openclaw.json` 是否存在
2. 读取 `gateway.auth.token` 字段
3. 连接 `ws://127.0.0.1:18789`，用读到的 token 做握手
4. 成功后存到 `~/.imcodes/openclaw.json`（权限 0600）

**Token 查找优先级**：
1. `--token` 命令行参数（最高优先级，远程场景）
2. `OPENCLAW_GATEWAY_TOKEN` 环境变量
3. `~/.openclaw/openclaw.json` → `gateway.auth.token`（本地自动读取）
4. 以上都没有 → 提示用户输入

## 能力分层

| Tier | 能力 | 设计 | 实现 |
|------|------|------|------|
| **Tier 1 (MVP)** | text message, delta/complete, error, status, streaming, heartbeat | ✅ 到位 | ✅ Day 1-3 |
| **Tier 2** | tool call, approval, attachments, SESSION_LIST, session restore | ✅ 接口预留 | 后续 |
| **Tier 3** | conversation replay, brain dispatcher 适配, 其他 provider | ✅ 架构预留 | 后续 |

**关键原则：避免的是接口重构，不是实现迭代。** 后续补 capabilities、加 event type、调 adapter 内部结构都正常。要避免的是改 SessionRuntime 核心语义、改 shared event 基本形态、改 provider contract 一级分类。

## 实施路径

### Preflight Gate ✅ 完成（2026-03-24）

- [x] Node.js WS client 连 gateway，完成握手 + agent RPC + 流式 event
- [x] 验证 session 隔离（不同 sessionKey → 不同 sessionId → 独立 JSONL）
- [x] 架构决策拍板：Gateway WS 直连，砍掉 OC extension 方案
- [x] 定义 `SessionRuntime` / `TransportProvider` 接口
- [x] 定义 `shared/agent-message.ts` + `shared/transport-events.ts`

### Day 1 ✅：shared 类型 + SessionRuntime + OpenClaw provider + connect 命令

- [x] shared 类型定义（`shared/agent-message.ts`, `shared/transport-events.ts`）
- [x] SessionRuntime + ProcessSessionRuntime + TransportSessionRuntime
- [x] OpenClaw provider（gateway WS 直连，`sessions.create` / `sessions.send` v3.24 协议）
- [x] `imcodes connect/disconnect openclaw` 命令
- [ ] 验收：创建 openclaw session → 发消息 → 收到 Pi 回复（需手动测试）

### Day 2 ✅：WsBridge + Web 前端

- [x] WsBridge transport event relay（`TRANSPORT_RELAY_TYPES` + 订阅机制）
- [x] Web session detail 渲染切换（terminal vs TransportChatView）
- [x] chat.delta 打字机效果 + chat.complete/error
- [x] Session 创建 UI 支持 openclaw（NewSessionDialog + StartSubSessionDialog）
- [x] Session 创建 UI — session key 选择（绑定现有 / 新建）
- [x] Session 创建 UI — description 输入框
- [x] i18n 全部 7 locale 更新
- [ ] 验收：浏览器端到端测试（需手动测试）

### Day 3 ✅：稳定性 + 质量

- [x] 断线自动重连（指数退避，最大 5 分钟）
- [x] Session 恢复（`restoreSession` + `listSessions`）
- [x] Tick 心跳检测（90s 无 tick → 判定连接 stale → 触发重连）
- [x] Provider 模板（`src/agent/providers/_template.ts`）
- [x] 全量 typecheck 通过（daemon + server + web）
- [x] 单元测试 52 个（TransportSessionRuntime 14 + OpenClawProvider 17 + Shared types 21）
- [ ] 验收：长回复流式 + 断线恢复（需手动测试）

### Day 4+：生态曝光（未开始）

- [ ] ClawHub Skills（3-5 个）
- [ ] awesome-openclaw-skills PR
- [ ] OC Discord 社区运营
- [ ] Demo 视频

### 审计结果（2026-03-25，六轮 P2P 审计，18 个审计 pass）

**Tier 1 — 已修复的实现级 Bug（P0/P1 → 全部清零）：**
- `send()` 失败时状态卡死 → try/catch 恢复到 idle
- `_history` 缺少 user 消息 → `send()` 记录完整会话历史（user + assistant）
- 前端 message ID 碰撞 (`Date.now()`) → counter-based `uniqueId()`
- `onError` 回 idle（违反 spec） → 改为 `error` 状态，下次 send 自动恢复
- `chat.error` 前端洗白为 idle → 保持 error 状态
- `AgentStatus` 类型缺少 `error` 值 → 已添加
- Send 按钮 streaming 时未禁用 → 已禁用
- `runAccumulator` 断线未清理 → `disconnect()` 清理
- 无并发发送保护 → `_sending` flag + `isStreaming` guard
- 未使用 `useRef` 导入 → 已移除

**Tier 2 — MVP 简化实现（已验证可用，接受当前行为）：**
- Agent 状态主要通过 delta/complete/error 事件推断，前端已具备 `chat.status` 消费能力，但 daemon 侧尚未建立显式状态推送链路 — 留待 Tier 2 补全
- 预流式阶段使用 `thinking` 状态（已在 `shared/transport-events.ts` 的 `TransportAgentStatus` 中定义）
- `sessions.abort` — 无法中断运行中的 agent
- `sessions.messages.subscribe` — 多客户端同 session 不同步
- `sessions.get` — 刷新/重连后历史不恢复
- Provider callback 数组 append-only — 高频 session churn 场景可能积累
- `session.send` 路由已在前轮 audit trace 中确认正常（`isTransportAgent()` → `TransportSessionRuntime.send()`）

**Tier 3 — OpenSpec 文档残留（已同步）：**
- ~~`session-runtime/spec.md` 旧 extension/SESSION_START 措辞~~ — 已对齐到 gateway WS 直连
- ~~`transport-provider/spec.md` 旧 `agent` RPC 主路径~~ — 已改为 `sessions.create` / `sessions.send`
- ~~`design.md` 决策/事件映射/open questions~~ — 已全部同步

**Tier 4 — DB 持久化 + 端到端同步（第四、五轮审计，已修复）：**
- ~~`sessions` / `sub_sessions` 缺少 transport 元数据列~~ — migration `022_transport_session_metadata.sql`
- ~~`upsertDbSession()` / `createSubSession()` 丢弃 transport 字段~~ — 已扩展
- ~~session sync API 不传递 transport 字段~~ — `session-mgmt.ts` PUT 已更新
- ~~daemon `persistSessionToWorker()` 不发送 transport 字段~~ — `lifecycle.ts` 已补全
- ~~daemon `session_list` WS 消息缺少 `providerId`/`providerSessionId`/`description`~~ — `command-handler.ts` 已补全
- ~~4 个存量 `Db*` 接口缺字段~~ — `DbServer.bound_with_key_id`、`DbChannelBinding.bot_id`、`DbCronJob.status`、`DbDiscussionRound.server_id` 已补齐
- Schema drift 自动检测测试（20 tests）覆盖 10 张表，零 warning

**Tier 5 — 类型对齐（第六轮审计发现，已修复）：**
- ~~`TransportAgentStatus` 和前端 `TransportStatus` 缺少 `'error'` 值~~ — 导致不安全的 `as` 类型断言，已补齐并移除 cast
- ~~daemon `AgentStatus` 与 shared `TransportAgentStatus` 不一致~~ — 两者现在都包含 `error`

**已知 MVP 技术债（已接受，不阻塞交付）：**
- Provider callback 数组 append-only — 高频 session churn 场景可能积累，后续改为 Map 或返回 unsubscribe
- `chat.status` 事件前端已消费但 daemon 侧未显式产出 — 状态通过 delta/complete/error 推断，Tier 2 补全
- Schema drift 测试验证 interface↔DB 列对齐，不验证端到端数据流 — 后续可增加 transport session 持久化集成测试

### 后续 Provider

| Provider | 连接模式 | 优先级 | 说明 |
|----------|----------|--------|------|
| MiniMax | per-request HTTP | 近期 | SSE streaming |
| DeepSeek | per-request HTTP | 近期 | SSE streaming |
| CC SDK | local-sdk | 中期 | `@anthropic-ai/claude-code` |
| Codex SDK | local-sdk | 中期 | `@openai/codex` |

每个新 provider 只需新增 `src/agent/providers/xxx.ts`，不改接口。

## Preflight 验证发现（2026-03-24）

### 本机 OC 环境

- **版本**: OpenClaw 2026.3.7 (42a1394)，全局安装 `/opt/homebrew/lib/node_modules/openclaw/`
- **Gateway**: 运行中，端口 18789（launchd: `ai.openclaw.gateway`）
- **Agent**: 3 个 — Main（default）、Emma、PPT，均用 `claude-opus-4-6`
- **Channel**: Telegram（default + emma 两账号）、Discord、Feishu
- **插件**: 39 stock + 1 third-party（claude-mem），7 已加载
- **Config**: `~/.openclaw/openclaw.json`
- **状态目录**: `~/clawd/`（workspace、agents、memory、skills 等）
- **Extensions 目录**: `~/.openclaw/extensions/`（第三方插件安装位置）

### 发现 1：Gateway WS 协议可直连

OC Gateway 是一个 **WebSocket RPC 服务器**，支持：

- **认证**: token-based（`gateway.auth.token` 或 `OPENCLAW_GATEWAY_TOKEN`）
- **帧协议**: `req` / `res` / `event` 三种帧类型
- **`agent` RPC 方法**: 向 agent 发消息并获取流式回复
  - 参数: `message`, `agentId`, `sessionKey`, `thinking`, `deliver`, `extraSystemPrompt`, `idempotencyKey` 等
  - 返回: `runId`，后续通过 event 帧流式推送
  - **重要**: `res` 帧在所有 `event` 帧之后才到达（先收完全部流式 event，最后收 res 确认）
- **Agent event 流**: `{ event: "agent", payload: { runId, seq, stream: "lifecycle"|"assistant"|"error", data } }`
- **~50+ RPC 方法**: agent, sessions.list/resolve/reset, config.get/set, health, status, cron.*, logs.tail 等

**验证方式**: `openclaw gateway call health/status --token <token> --json` 均正常返回。

#### Gateway WS ConnectParams 格式（实现参考）

```javascript
// connect.challenge 事件到达后，发送 connect 请求
{
  minProtocol: 3, maxProtocol: 3,
  client: {
    id: 'gateway-client',
    version: '0.1.0',
    platform: 'darwin',
    mode: 'backend',
    displayName: 'imcodes-daemon'
  },
  auth: { token: '<从 ~/.openclaw/openclaw.json 自动读取>' },
  role: 'operator',
  scopes: ['operator.write', 'operator.read', 'operator.admin']
}
```

**scopes 说明**（v2026.3.24 scope 体系，5 个 scope）:
- `operator.read` — sessions.list/get/preview, sessions.messages.subscribe
- `operator.write` — sessions.create/send/steer/abort, agent, chat.send（**v3.24 新增**，原来这些都需要 admin）
- `operator.admin` — sessions.reset/delete/patch/compact, config.*, cron.*（超集，包含 read + write 权限）
- `operator.approvals` — exec.approval.*
- `operator.pairing` — device.*

> **最小权限**: MVP 只需 `['operator.write', 'operator.read']`。加 `operator.admin` 是为了 `sessions.reset`。

#### Sessions RPC 请求格式（v2026.3.24 推荐）

```javascript
// 创建 session
{ method: 'sessions.create', params: {
  key: 'imcodes:srv1:deck_myapp_brain',
  agentId: 'main',
  label: 'IM.codes brain session',
  // parentSessionKey: '...',  // 可选：sub-session 关联
}}

// 发消息（替代 agent RPC）
{ method: 'sessions.send', params: {
  key: 'imcodes:srv1:deck_myapp_brain',
  message: '用户消息内容',
  thinking: 'off',
  idempotencyKey: '<uuid>',
}}

// 订阅消息事件
{ method: 'sessions.messages.subscribe', params: { key: '...' }}

// 获取历史
{ method: 'sessions.get', params: { key: '...', limit: 200 }}
```

#### Agent RPC 请求格式（仍可用，向后兼容）

```javascript
{
  method: 'agent',
  params: {
    sessionKey: 'imcodes:srv1:deck_myapp_brain',
    message: '用户消息内容',
    agentId: 'main',           // OC agent ID
    thinking: 'off',           // 'off' | 'on'
    idempotencyKey: '<uuid>',  // 防重复
    // deliver: true,          // 可选：让 OC 同时推送到 Telegram/Discord
    // extraSystemPrompt: '',  // 可选：注入额外 system prompt
  }
}
```

**Preflight 验证脚本**: `scripts/verify-oc-gateway.mjs`（可用于调试和回归验证）

### 发现 2：ACP（Agent Control Protocol）

OC 内置 ACP — 专门为**外部客户端控制 AI agent** 设计：

```typescript
interface AcpRuntime {
  ensureSession(input): Promise<AcpRuntimeHandle>;
  runTurn(input): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities?(handle): Promise<AcpRuntimeCapabilities>;
  getStatus?(handle, signal?): Promise<AcpRuntimeStatus>;
  setMode?(handle, mode): Promise<void>;
  cancel(handle, reason?): Promise<void>;
  close(handle, reason): Promise<void>;
}
```

**AcpRuntimeEvent 类型**:
- `text_delta` — 流式文本（output / thought stream）
- `status` — 状态更新（token 使用量等）
- `tool_call` — 工具调用
- `done` — turn 完成
- `error` — 错误

**Session key 格式**: `agent:<agentId>:acp:<uuid>`

ACP 的流式事件模型和我们 `TransportEvent` 的设计几乎 1:1 对应。

### 发现 3：ChannelPlugin 接口

OC 的 ChannelPlugin 是为**聊天平台**设计的：

```typescript
type ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter;        // 账号管理
  outbound?: ChannelOutboundAdapter;   // 发消息（sendText/sendMedia/sendPoll）
  gateway?: ChannelGatewayAdapter;     // 连接管理（startAccount/stopAccount）
  security?: ChannelSecurityAdapter;   // 访问控制
  groups?: ChannelGroupAdapter;        // 群组
  streaming?: ChannelStreamingAdapter; // 流控
  // ... 十几个 adapter
};
```

注册方式: `api.registerChannel({ plugin: myPlugin as ChannelPlugin })`

**结论**: ChannelPlugin 是给 Telegram/Discord/WhatsApp 这类消息平台用的。IM.codes 不是一个"聊天平台"，它是一个 agent 控制面板。用 ChannelPlugin 来集成是**语义不匹配**的。

### 发现 4：Plugin API

```typescript
const plugin = {
  id: "my-plugin",
  register(api: OpenClawPluginApi) {
    api.registerChannel(...)       // 注册聊天平台
    api.registerTool(...)          // 注册 LLM 工具
    api.registerHook(...)          // 注册生命周期钩子
    api.registerCommand(...)       // 注册命令（绕过 LLM）
    api.registerHttpRoute(...)     // 注册 HTTP 路由
    api.registerGatewayMethod(...) // 注册 gateway RPC 方法
    api.registerService(...)       // 注册后台服务
    api.registerProvider(...)      // 注册 AI model provider
  },
};
```

Plugin 可以注册**自定义 gateway 方法**和 **HTTP 路由** — 这比做 ChannelPlugin 更灵活。

### 架构决策变更

**原方案**: 建 `@imcodes/openclaw-channel` ChannelPlugin extension，开 WS server on loopback，daemon 连入。

**新发现后的三个可选方案**:

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A: Gateway WS 直连** | daemon 作为 gateway client，用 `agent` RPC 发消息 | 最简单，零 extension，开箱即用 | 受限于 gateway 公开 API；session 管理受 OC 控制 |
| **B: ACP Bridge** | daemon 实现 ACP client，通过 ACP 协议控制 OC agent | 语义最匹配（外部 agent 控制）；原生流式事件 | ACP 是 ACPX 插件驱动，需要了解更多细节 |
| **C: 轻量 Extension**（原方案变体）| 不做 ChannelPlugin，改用 `registerGatewayMethod` + `registerHttpRoute` | 自定义协议，灵活度最高 | 仍需开发+安装 extension |

**推荐: 方案 A（Gateway WS 直连）作为 MVP**

理由：
1. 零依赖 — 不需要安装任何 OC extension
2. 已验证 — `openclaw gateway call` 已经能正常工作
3. 完全解耦 — OC 保持原样，IM.codes 只是一个 gateway client
4. 流式支持 — `agent` 方法返回 event 流
5. 后续可升级 — 如果需要更深集成，再引入 extension/ACP

**实施调整**:
- 砍掉 Phase 2（OC Channel Extension）整个阶段
- Phase 1 (Preflight) 中的 1.2/1.3（ChannelPlugin 验证/WS server 验证）替换为 gateway client 连接验证
- OpenClaw provider 直接用 gateway WS client 实现
- 认证用 gateway token（已有），不需要 extension 的 access_token 机制

### 待验证项（session 绑定相关）

- [x] `sessions.list` RPC — 需要 `operator.read` scope ✅ v3.24 确认
- [ ] `sessions.resolve` RPC — 获取单个 session 详情（token 用量、displayName 等）
- [ ] 确认绑定已有 session 后发消息是否正常追加到该 session 的 JSONL
- [ ] 验证 `sessions.create` + `sessions.send` 新 RPC 是否可替代 `agent` RPC（需升级本地 OC 到 v3.24+）

### 已验证项

- [x] **WS 握手**: `connect.challenge`(nonce) → `connect`(token auth) → `hello-ok`(protocol 3, 95 methods, 19 events) ✅
- [x] **Agent RPC**: `method: "agent"` 发消息 → 返回 `runId` → event 流推送 ✅
- [x] **流式 event 格式**: `event: "agent"` 帧，payload 含 `stream` + `data`：
  - `stream: "lifecycle"` — `phase: "start" | "error" | "end"`
  - `stream: "assistant"` — `text`（累积全文）+ `delta`（增量）
  - `stream: "error"` — seq gap 等协议错误
  - 另有 `event: "chat"` 帧（状态汇总：`state: "error" | "done"`）
- [x] **Delta 粒度**: token 级增量（`"IMCODES_PREFLIGHT"` → `"_OK"`）
- [x] **Session 隔离**: 不同 `sessionKey` 分配不同 `sessionId`，对应独立 JSONL 文件，上下文完全隔离 ✅
  - `sessionKey` 是路由标签，`sessionId`（UUID）是隔离单位
  - JSONL 存储于 `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
- [x] **Session 复用**: 同一 `sessionKey` 多次请求使用同一 `sessionId`，消息追加到同一 JSONL — 多轮对话正常工作
- [x] **401 自动重试**: OC gateway 遇到 OAuth 过期时自动用备用 profile 重试（seq gap + 新 lifecycle start）

### 待验证项

- [ ] 验证 `extraSystemPrompt` 是否可用于注入 session 角色/描述
- [x] 确认 `sessions.reset` 参数格式 ✅ 源码确认用 `key`，`reason` 可选（"new" | "reset"）
- [ ] 测试 `deliver: true` 是否可以让 OC 把回复同时发到 Telegram/Discord

### v2026.3.7 → v2026.3.24 协议变更记录

**新增 Session RPC（重要）**:
- `sessions.create` — 显式创建 session（key, agentId, label, model, parentSessionKey, 可附 initial message）
- `sessions.send` — 向 session 发消息（内部调用 chat.send，自动处理 canonicalKey、messageSeq、subagent 重激活）
- `sessions.steer` — 同 send 但先中断当前活跃 run
- `sessions.abort` — 中断 session 当前 run
- `sessions.get` — 获取 session 消息历史（支持 limit 分页）
- `sessions.messages.subscribe/unsubscribe` — 订阅/取消 session 消息实时推送
- `sessions.compact` — 压缩 session transcript

**Scope 体系扩展**（从 2 个变为 5 个）:
- 新增 `operator.write` — agent、chat.send、sessions.create/send/steer/abort
- 新增 `operator.approvals` — exec.approval.*
- 新增 `operator.pairing` — device.*
- `operator.admin` 仍是超集，包含所有权限

**Auth 握手扩展**:
- `auth.bootstrapToken` — 设备首次配对用（新增）
- `auth.deviceToken` — 设备持久 token（新增）
- `auth.token` — gateway token（不变，我们使用这个）

**Token 自动获取**:
- 本地连接可从 `~/.openclaw/openclaw.json` → `gateway.auth.token` 自动读取
- 无需用户手动输入，零交互完成连接

**协议版本**: 仍为 v3（minProtocol: 3, maxProtocol: 3），无破坏性变更
**事件流格式**: 不变（event: "agent", stream: lifecycle/assistant/error）

## MVP 排除项

- 不做 process-backed 消息模型统一（tmux 继续用 binary frame）
- 不做 tool call / approval 展示（接口预留，实现后续）
- 不做 SESSION_LIST / session restore（接口预留，实现后续）
- 不做 brain dispatcher 适配 transport agent
- 不做附件/媒体处理
- 不做 conversation replay

## 度量

| 类型 | 指标 |
|------|------|
| **采纳** | connect 使用次数、openclaw session 创建数 |
| **活跃** | 混搭 session 比例（OC brain + CC worker） |
| **体验** | 首次连接成功率、WS 断线率、消息往返 P95 延迟 |
| **留存** | 7 天二次使用率 |
| **深度** | OC session → 后续创建 worker / 进入文件/终端/审批 |

## 风险

| 风险 | 缓解 |
|------|------|
| OC gateway WS 协议变更 | daemon 使用的是 OC 公开协议（和 webchat/CLI 相同），变更会影响所有 OC 客户端 |
| Day 1 工作量膨胀 | 严格收窄到单 session 文本闭环 |
| Gateway token 泄露 | 存储在 `~/.imcodes/openclaw.json`（0600 权限），默认只连 loopback |
| 接口设计过早 | 基于三类已知 provider 差异设计，不做假想未来 |
| IM.codes 核心依赖 OC | 不会 — openclaw 是可选 agent type |
