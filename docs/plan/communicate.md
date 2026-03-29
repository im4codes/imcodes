# Agent Inter-Session Communication

## 目标

让 AI agent 在 session 内能主动给其他 session 发送消息/命令，实现 agent 间协作。

> **重要说明：** `imcodes send` 已存在于 `src/index.ts:260-271`，本计划是扩展现有命令，不是从零构建。底层原语是 **远程按键注入**（sendKeys → literal text + Enter），不是抽象的"消息传递"。安全设计必须基于这个认知。

## CLI 接口

```bash
# 发消息给同项目下的 session（按 label）
imcodes send "Plan" "review the changes in src/api.ts"

# 带文件上下文（agent-type-aware 注入）
imcodes send "Cx" "run tests for these" --files src/api.ts,src/types.ts

# 按 agent type 发（没 label 时）
imcodes send --type codex "run tests"

# 广播给所有 siblings（最多 8 个接收者）
imcodes send --all "migration done, check your end"

# 查看可用的 sibling sessions
imcodes send --list
```

大模型只需知道 `imcodes send` 命令，不需要了解自身身份或任何内部机制。

**P2P 讨论** 不需要单独命令 — agent 直接在输出中使用 `@@all` 或 `@@Label` 语法，daemon 的 brain-dispatcher / message-router 已有 `@@` 解析能力，自动拆包走 P2P orchestrator。

## 安全架构

### Hook Server 认证（Phase 1 前置条件）

现有 hook server (`localhost:51913`) 无认证，端口号写在 `~/.imcodes/hook-port` 中，任何本地进程可直接访问。浏览器可通过 simple POST（无 CORS preflight）跨域请求 localhost。添加 `/send` 端点前**必须**先保护整个 hook server。

```
Daemon 启动:
  1. 生成 32 字节随机 secret → hex 字符串
  2. 写入 ~/.imcodes/hook-secret (mode 0600)
  3. hook-port 文件也设为 mode 0600
  4. 所有 hook server 端点验证 Authorization: Bearer <secret>
  5. 验证 Content-Type: application/json（强制 CORS preflight）
  6. 请求体大小限制: 1MB

Agent 启动:
  1. IMCODES_HOOK_SECRET 注入到 env（与 IMCODES_SESSION 一起）
  2. CLI 读取 env（快）→ 回退读文件

现有 hook 调用方:
  - CC stop hook、signal handler 等需同步更新，发请求时带 Authorization header
```

### 消息安全

```typescript
// sendKeys 前的消息清洗
function sanitizeMessage(text: string): string {
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // 控制字符
    .replace(/\x02/g, '')                                  // tmux prefix (Ctrl-B)
    .slice(0, 100_000);                                    // 长度限制
}
```

### 防循环 & 限流

- **循环发送深度计数器**: `/send` payload 含 `depth` 字段，每次转发 +1，超过 3 拒绝
- **频率限制**: 每个源 session 最多 10 次/分钟
- **`--all` 接收者上限**: 最多 8 个

## 身份识别

Agent 不需要知道自己是谁。CLI 自动检测：

**优先级：**
1. `$IMCODES_SESSION` 环境变量 — 通用，所有平台/运行时
2. `$TMUX_PANE` → 查 tmux session name — fallback，仅 tmux 环境

> **不使用全局文件回退（如 `~/.imcodes/current-session`）。** 多个并发 session 会竞争同一文件，全局文件在多 session 架构下本质错误。

**`IMCODES_SESSION` + `IMCODES_HOOK_SECRET` 注入时机：**
- daemon 控制所有 agent 的启动命令（`buildLaunchCommand`），在启动时注入：
  ```bash
  IMCODES_SESSION=deck_sub_xxx IMCODES_HOOK_SECRET=abc123 claude --resume ...
  ```
- Transport (OpenClaw) — spawn 进程时传 env
- CC SDK 调用 — 调用方设 env
- Windows — env var 同样适用

## 实现链路

```
Agent (in session)
  → imcodes send CLI (已有命令，扩展)
    → reads $IMCODES_SESSION (or $TMUX_PANE fallback)
    → reads $IMCODES_HOOK_SECRET (or ~/.imcodes/hook-secret fallback)
    → reads ~/.imcodes/hook-port
    → POST http://localhost:{port}/send (Authorization: Bearer <secret>)
      → daemon hook-server handler:
        1. 验证 Authorization header
        2. 验证 Content-Type: application/json
        3. 验证 from session 存在 + 深度计数器 + 频率限制
        4. 从 from 的 parentSession 找同域 siblings
        5. 按 label/type/name 解析 target
        6. 检查 target 状态（idle → 立即发送，running → 排队，stopped → 拒绝）
        7. sanitizeMessage → sendKeys 注入
        8. 返回 { ok: true, target, delivered | queued }
```

## Hook Server 端点

### POST /send（需认证）
```json
{
  "from": "deck_sub_xxx",       // CLI 自动填充
  "to": "Plan",                  // label / session name / agent type
  "message": "review this",     // 必选
  "files": ["src/api.ts"],      // 可选
  "context": "...",              // 可选
  "depth": 0                     // 循环深度计数器
}
```

**响应：**
```json
{ "ok": true, "delivered": true, "target": "deck_sub_yyy" }
{ "ok": true, "queued": true, "reason": "target is busy" }
{ "ok": false, "error": "target not found", "available": ["Plan", "Cx", "Gm"] }
{ "ok": false, "error": "depth limit exceeded" }
{ "ok": false, "error": "rate limit exceeded" }
```

## 目标解析

同一 parentSession 下查找，优先级：
1. **label** 精确匹配（大小写不敏感）— 多个匹配返回错误 + 候选列表
2. **session name** 精确匹配（deck_sub_xxx）
3. **agent type** 匹配（claude-code / codex / gemini）— 多个匹配返回错误 + 候选列表
4. 找不到 → 返回错误 + 可用 session 列表

## Queue-When-Busy 机制

目标 session 状态为 `running` 时不立即注入（可能丢失、打断、误触确认提示），而是排队等 idle：

```typescript
// 队列设计
- 内存队列（daemon 重启丢失 — 可接受）
- 每个目标最多 10 条排队消息
- 消息过期时间: 5 分钟
- target 变为 idle 时 FIFO 投递
- CLI 收到 { queued: true } 响应，agent 知道消息会延迟投递
```

## `--files` 处理

`--files` 注入格式取决于目标 agent 类型（`@path` 只有 Claude Code 理解）：

| 目标 Agent | 文件注入格式 |
|-----------|------------|
| claude-code | `@path/to/file` 前缀（原生文件引用） |
| codex / gemini / shell | 文件路径作为纯文本附加在消息末尾 |

## 终端复用器抽象层（TerminalMux）— Phase 3

> **与 `imcodes send` 解耦。** 消息功能已经足够复杂（认证、排队、清洗、限流），TerminalMux 是独立的跨平台重构项目。

### 接口定义

```typescript
// src/agent/mux.ts
interface TerminalMux {
  name: string;  // 'tmux' | 'wezterm'
  newSession(name: string, cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<void>;
  killSession(name: string): Promise<void>;
  sessionExists(name: string): Promise<boolean>;
  listSessions(): Promise<string[]>;
  sendKeys(name: string, keys: string): Promise<void>;
  capturePane(name: string): Promise<string[]>;
  respawnPane(name: string, cmd: string): Promise<void>;
  getPaneCwd(name: string): Promise<string>;
  getPaneId(name: string): Promise<string | undefined>;
  getPaneCommand(name: string): Promise<string>;
}
```

### 实现

```
src/agent/mux.ts              — interface + lazy detect (getMux()) + export
src/agent/mux/tmux.ts         — tmux 实现（从现有 tmux.ts 迁移）
src/agent/mux/wezterm.ts      — WezTerm 实现 + name→pane_id 映射层
```

### WezTerm 注意事项

- **WezTerm 无命名 session** — 需要 `name→pane_id` 映射层，持久化到 `~/.imcodes/wezterm-sessions.json`
- **`respawnPane` 无直接等价** — kill 进程后重新注入命令，或 kill+spawn 更新映射
- **`capturePane` 输出格式不同** — 各实现需做输出归一化
- **`sendKeys` 时序模型不同** — tmux 分步（text + 延迟 + Enter），WezTerm 原子（text+newline 一次性）
- **使用 lazy init `getMux()`**，不用 top-level await（避免测试/import 问题）

### WezTerm 命令映射

| 操作 | tmux | WezTerm CLI |
|------|------|------------|
| 新建 session | `tmux new-session -d -s name 'cmd'` | `wezterm cli spawn --new-window -- cmd` + 映射 name→id |
| 关闭 session | `tmux kill-session -t name` | `wezterm cli kill-pane --pane-id id` |
| 列出 sessions | `tmux list-sessions -F '#S'` | `wezterm cli list --format json` |
| 发送按键 | `tmux send-keys -t name -l 'text'` | `wezterm cli send-text --pane-id id 'text'` |
| 捕获输出 | `tmux capture-pane -t name -p` | `wezterm cli get-text --pane-id id` |

## 跨平台支持

| 平台 | 终端复用器 | 身份检测 | TerminalMux 实现 |
|------|-----------|---------|-----------------|
| Linux/macOS | tmux | $IMCODES_SESSION > $TMUX_PANE | TmuxMux |
| Windows | WezTerm | $IMCODES_SESSION | WezTermMux |
| Linux/macOS (alt) | WezTerm | $IMCODES_SESSION | WezTermMux |
| Transport (OC) | 无 | $IMCODES_SESSION | provider API (不走 mux) |
| CC SDK | 无 | $IMCODES_SESSION | SDK stdin pipe (不走 mux) |

## Agent Prompt 集成

通过 `memory-inject.ts` 在 agent 启动时注入 system prompt（不依赖项目 CLAUDE.md）：

```markdown
## Inter-Agent Communication

To send a message to another agent session:
  imcodes send "<label>" "<message>"
  imcodes send "<label>" "<message>" --files file1.ts,file2.ts

Use `imcodes send --list` to see available sibling sessions.
```

## 实现阶段

### Phase 1: 安全的 `imcodes send`（tmux only）
- [ ] **认证:** hook server 全端点 shared-secret 认证 + Content-Type 校验
- [ ] **文件权限:** hook-port、hook-secret 文件 mode 0600
- [ ] **Env 注入:** 所有 agent driver launch command 注入 `IMCODES_SESSION` + `IMCODES_HOOK_SECRET`
- [ ] **扩展现有 CLI:** `src/index.ts` 的 `imcodes send` 增加 label 解析 + hook server IPC
- [ ] **Hook 端点:** `POST /send`（认证、校验、body 大小限制）
- [ ] **目标解析:** label/name/type → session name，含碰撞处理
- [ ] **消息清洗:** sanitizeMessage（控制字符、tmux 前缀、长度限制）
- [ ] **Queue-when-busy:** running 状态排队，idle 时投递，5min 过期
- [ ] **防护:** 循环深度计数器 (max 3) + 频率限制 (10/min/source) + `--all` 上限 (8)
- [ ] **Prompt 注入:** memory-inject.ts 自动注入 `imcodes send` 文档
- [ ] **更新现有 hook 调用方:** CC stop hook 等加 Authorization header

### Phase 2: 增强
- [ ] `--files` agent-type-aware 渲染
- [ ] `--list` / `--status` 查看 siblings
- [ ] 投递确认（target idle 后回传通知 sender）
- [ ] `--all` 接收者上限 (max 8)

### Phase 3: TerminalMux 抽象 + Windows
- [ ] 提取 `TerminalMux` interface
- [ ] `TmuxMux` 实现（从 tmux.ts 迁移）
- [ ] `WezTermMux` 实现 + name→pane_id 映射层
- [ ] respawn 语义处理
- [ ] capturePane 输出归一化
- [ ] lazy init `getMux()`
- [ ] 迁移所有上层调用方
