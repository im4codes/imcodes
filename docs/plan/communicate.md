# Agent Inter-Session Communication

## 目标

让 AI agent 在 session 内能主动给其他 session 发送消息/命令，实现 agent 间协作。

> **重要说明：** `imcodes send` 已存在于 `src/index.ts:260-271`，本计划是扩展现有命令。底层原语是 **远程按键注入**（sendKeys → literal text + Enter），不是抽象的"消息传递"。

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

> **向后兼容：** 现有 `imcodes send <session-name> <message>` 格式继续工作（目标解析优先级 #2 匹配 session name）。

**P2P 讨论** 不需要单独命令 — agent 直接在输出中使用 `@@all` 或 `@@Label` 语法，daemon 的 brain-dispatcher / message-router 已有 `@@` 解析能力，自动拆包走 P2P orchestrator。

## 安全

### 浏览器跨域防护

唯一需要防的攻击面：恶意网页通过 `fetch('http://localhost:51913/send')` 注入按键。

**方案：** hook server 要求 `Content-Type: application/json`。浏览器对 JSON content-type 强制 CORS preflight（OPTIONS），hook server 不返回任何 CORS header、不实现 OPTIONS 处理 → 浏览器自动拦截。非 JSON content-type 请求返回 415。

CLI / agent 调用不经过浏览器，不受 CORS 影响。

**不做 token/secret 认证。** 本机同用户进程可以读文件、dump 内存、ptrace — 任何 shared secret 对同用户进程无实际安全价值。开源项目接受本机用户信任模型。

### 其他防护

- 请求体大小限制: 1MB
- hook-port 文件 mode 0600（防其他用户读取）

### 消息清洗

清洗逻辑在 TerminalMux 实现内（各平台有不同的危险字符）：

```typescript
// TmuxMux.sanitize()
text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // 控制字符
    .replace(/\x02/g, '')                                  // tmux prefix (Ctrl-B)
    .slice(0, 100_000)

// WezTermMux.sanitize()
text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // 控制字符（无 prefix key）
    .slice(0, 100_000)
```

### 防循环 & 限流

- **循环发送深度计数器**: `/send` payload 含 `depth` 字段，每次转发 +1，超过 3 拒绝
- **频率限制**: 每个源 session 最多 10 次/分钟
- **`--all` 接收者上限**: 最多 8 个

## 身份识别

Agent 不需要知道自己是谁。CLI 自动检测：

**优先级：**
1. `$IMCODES_SESSION` 环境变量 — 通用，所有平台/运行时
2. `$WEZTERM_PANE` → WezTerm pane-id → name 映射查找 — WezTerm 环境
3. `$TMUX_PANE` → 查 tmux session name — tmux 环境

> **不使用全局文件回退（如 `~/.imcodes/current-session`）。** 多个并发 session 会竞争同一文件，全局文件在多 session 架构下本质错误。

**`IMCODES_SESSION` 注入：** 通过 `newSession(name, cmd, { env: { IMCODES_SESSION: name } })` 注入，使用现有 `extraEnv` 启动路径（`session-manager.ts`），不修改 driver 的 `buildLaunchCommand`。

## 架构：两层分离

### Layer 1: TerminalMux（低层，per-platform）

```typescript
// src/agent/mux.ts

interface MuxSessionOpts {
  cwd?: string;
  env?: Record<string, string>;  // IMCODES_SESSION 在这里注入
}

interface TerminalMux {
  readonly name: 'tmux' | 'wezterm';

  // Lifecycle
  newSession(name: string, cmd: string, opts?: MuxSessionOpts): Promise<void>;
  killSession(name: string): Promise<void>;
  sessionExists(name: string): Promise<boolean>;
  listSessions(): Promise<string[]>;
  respawnPane(name: string, cmd: string): Promise<void>;

  // I/O (raw terminal operations)
  sendText(name: string, text: string): Promise<void>;   // raw text, no Enter
  sendKey(name: string, key: string): Promise<void>;      // single key (Enter, Escape, etc.)
  capturePane(name: string): Promise<string[]>;           // normalized output lines

  // Introspection
  getPaneCwd(name: string): Promise<string>;
  getPaneId(name: string): Promise<string | undefined>;
  getPaneStartCommand(name: string): Promise<string>;
  isPaneAlive(name: string): Promise<boolean>;

  // Platform-specific
  sanitize(text: string): string;       // strip mux-specific control chars
  reconcile(): Promise<void>;           // prune stale mappings (no-op for tmux)
}
```

**实现：**
```
src/agent/mux.ts              — interface + lazy detect (getMux()) + export
src/agent/mux/tmux.ts         — TmuxMux（从现有 tmux.ts 迁移）
src/agent/mux/wezterm.ts      — WezTermMux + name→pane_id 映射层
```

**自动检测（lazy init，不用 top-level await）：**
```typescript
let cached: TerminalMux | null = null;
export async function getMux(): Promise<TerminalMux> {
  if (cached) return cached;
  // 1. $IMCODES_MUX 环境变量（用户强制指定）
  // 2. which tmux → TmuxMux
  // 3. which wezterm → WezTermMux
  // 4. 都没有 → 报错
  cached = detected;
  return cached;
}
```

### Layer 2: Agent Message Delivery（高层，platform-agnostic）

```typescript
// src/agent/agent-send.ts

async function sendMessageToAgent(
  mux: TerminalMux,
  sessionName: string,
  message: string,
  opts?: { tempDir?: string; longThreshold?: number },
): Promise<void> {
  const clean = mux.sanitize(message);

  if (clean.length <= (opts?.longThreshold ?? 4000)) {
    // Short message: send literal text + Enter
    await mux.sendText(sessionName, clean);
    await sleep(100);
    await mux.sendKey(sessionName, 'Enter');
  } else {
    // Long message: write temp file + send meta-instruction
    const tmpDir = opts?.tempDir ?? os.tmpdir();  // cross-platform
    const file = path.join(tmpDir, `.imcodes-prompt-${randomUUID().slice(0, 12)}.md`);
    await fs.writeFile(file, clean, 'utf-8');
    await mux.sendText(sessionName, `Read and execute all instructions in @${file}`);
    await sleep(100);
    await mux.sendKey(sessionName, 'Enter');
    setTimeout(() => fs.unlink(file).catch(() => {}), 30_000);
  }
}
```

> **注意：** 长文本临时文件路径使用 `os.tmpdir()`（Windows: `C:\Users\xxx\AppData\Local\Temp`，Unix: `/tmp`），不硬编码 `/tmp`。

## 实现链路

```
Agent (in session)
  → imcodes send CLI (已有命令，扩展)
    → reads $IMCODES_SESSION (> $WEZTERM_PANE > $TMUX_PANE fallback)
    → reads ~/.imcodes/hook-port
    → POST http://localhost:{port}/send (Content-Type: application/json)
      → daemon hook-server handler:
        1. 验证 Content-Type: application/json（阻止浏览器跨域）
        2. 验证 body < 1MB
        3. 验证 from session 存在 + 深度计数器 + 频率限制
        4. 从 from 的 parentSession 找同域 siblings
        5. 按 label/type/name 解析 target
        6. 检查 target 状态（idle → 立即发送，running → 排队，stopped → 拒绝）
        7. sendMessageToAgent(mux, target, message)
        8. 返回 { ok: true, target, delivered | queued }
```

## Hook Server 端点

现有 hook server 是 CC-specific 的（`/notify` 只接受 `claude-code` session）。`/send` 是通用的 agent-to-agent 端点，需要独立的校验逻辑。

```
POST /notify    ← CC-specific（现有，不变）
  - 验证: session 必须是 claude-code 类型
  - 处理: hookNotify()

POST /send      ← 通用 agent-to-agent（新）
  - 验证: Content-Type: application/json, body < 1MB
  - 验证: from session 存在（任意类型）
  - 处理: hookSend()
```

### POST /send

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

目标 session 状态为 `running` 时不立即注入，排队等 idle：

- 内存队列（daemon 重启丢失 — 可接受，CLI 响应包含 `queued: true` 提示）
- 每个目标最多 10 条排队消息
- 消息过期时间: 5 分钟
- target 变为 idle 时 FIFO 投递
- 状态检测使用 `capturePane` + `detect.ts`（需确保 WezTerm 输出经过归一化后与 tmux 行为一致）

## `--files` 处理

注入格式取决于目标 agent 类型：

| 目标 Agent | 文件注入格式 |
|-----------|------------|
| claude-code | `@path/to/file` 前缀（原生文件引用） |
| codex / gemini / shell | 文件路径作为纯文本附加在消息末尾 |

## WezTerm 实现要点

- **无命名 session** — `name→pane_id` 映射持久化到 `~/.imcodes/wezterm-sessions.json`，原子写入
- **reconcile() 触发时机**: 启动 + 每 60s + sendKeys 失败时
- **`respawnPane`** — kill 进程（via PID） + 重新注入命令作为文本，或 kill-pane + spawn 更新映射
- **`capturePane` 归一化** — trim trailing whitespace per line，与 tmux 输出格式一致
- **`sendKey`** — WezTerm `send-text` 发送 `\n` 代替 Enter，`\x1b` 代替 Escape
- **`newSession` 必须传 `--cwd`** — 否则继承 WezTerm server cwd 而非 daemon cwd

### WezTerm 命令映射

| 操作 | tmux | WezTerm CLI |
|------|------|------------|
| 新建 session | `tmux new-session -d -s name -c cwd 'cmd'` | `wezterm cli spawn --cwd cwd -- cmd` + 映射 name→id |
| 关闭 session | `tmux kill-session -t name` | `wezterm cli kill-pane --pane-id id` |
| 列出 sessions | `tmux list-sessions -F '#S'` | `wezterm cli list --format json` |
| 发送文本 | `tmux send-keys -t name -l 'text'` | `wezterm cli send-text --pane-id id --no-paste 'text'` |
| 发送按键 | `tmux send-keys -t name Enter` | `wezterm cli send-text --pane-id id '\n'` |
| 捕获输出 | `tmux capture-pane -t name -p` | `wezterm cli get-text --pane-id id` |

## 跨平台支持

| 平台 | 终端复用器 | 身份检测 | TerminalMux |
|------|-----------|---------|------------|
| Linux/macOS | tmux | $IMCODES_SESSION > $TMUX_PANE | TmuxMux |
| Windows | WezTerm | $IMCODES_SESSION > $WEZTERM_PANE | WezTermMux |
| Linux/macOS (alt) | WezTerm | $IMCODES_SESSION > $WEZTERM_PANE | WezTermMux |
| Transport (OC) | 无 | $IMCODES_SESSION | provider API (不走 mux) |
| CC SDK | 无 | $IMCODES_SESSION | SDK stdin pipe (不走 mux) |

## Agent Prompt 集成

通过 `src/daemon/memory-inject.ts` 在 agent 启动时注入 system prompt：

```markdown
## Inter-Agent Communication

To send a message to another agent session:
  imcodes send "<label>" "<message>"
  imcodes send "<label>" "<message>" --files file1.ts,file2.ts

Use `imcodes send --list` to see available sibling sessions.
```

## 实现阶段

### Phase 1: TerminalMux 抽象 + `imcodes send`（一次性完成）

**1a. TerminalMux 抽象：**
- [ ] 定义 `TerminalMux` interface（sendText/sendKey/sanitize/reconcile/isPaneAlive/getPaneStartCommand）
- [ ] `TmuxMux` 实现（从 `tmux.ts` 迁移）
- [ ] `WezTermMux` 实现（name→pane_id 映射层 + reconcile + --cwd）
- [ ] lazy init `getMux()`（不用 top-level await）
- [ ] 迁移所有上层调用方到 `mux.*`

**1b. Agent Message Delivery：**
- [ ] `sendMessageToAgent()`（共享层：短文本 sendText+Enter / 长文本 temp file，用 `os.tmpdir()`）
- [ ] `IMCODES_SESSION` env 注入（通过 `newSession({ env })`，不改 driver command strings）

**1c. `imcodes send` 消息功能：**
- [ ] CORS 防护：所有端点要求 `Content-Type: application/json`，非 JSON 返回 415，不实现 OPTIONS
- [ ] 请求限制：body < 1MB，hook-port 文件 mode 0600
- [ ] 扩展现有 `imcodes send` CLI：label 解析 + hook server IPC
- [ ] Hook 端点 `POST /send`（与 CC-only `/notify` 分开校验逻辑）
- [ ] 目标解析：label/name/type → session name，碰撞处理
- [ ] Queue-when-busy：running 排队 → idle 投递 → 5min 过期
- [ ] 防护：循环深度 (max 3) + 频率限制 (10/min/source) + `--all` 上限 (8)
- [ ] Prompt 注入：`src/daemon/memory-inject.ts` 自动注入 `imcodes send` 文档

### Phase 2: 增强
- [ ] `--files` agent-type-aware 渲染
- [ ] `--list` / `--status` 查看 siblings
- [ ] 投递确认（target idle 后回传通知 sender）
- [ ] Windows daemon 生命周期（无 systemd — 后台 Node.js 进程或 Windows Service）
