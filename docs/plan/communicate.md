# Agent Inter-Session Communication

## 目标

让 AI agent 在 session 内能主动给其他 session 发送消息/命令，实现 agent 间协作。

## CLI 接口

```bash
# 发消息给同项目下的 session（按 label）
imcodes send "Plan" "review the changes in src/api.ts"

# 带文件上下文（注入为 @ 引用）
imcodes send "Cx" "run tests for these" --files src/api.ts,src/types.ts

# 按 agent type 发（没 label 时）
imcodes send --type codex "run tests"

# 广播给所有 siblings
imcodes send --all "migration done, check your end"

# 查看可用的 sibling sessions
imcodes send --list
```

大模型只需知道 `imcodes send` 命令，不需要了解自身身份或任何内部机制。

**P2P 讨论** 不需要单独命令 — agent 直接在输出中使用 `@@all` 或 `@@Label` 语法，daemon 的 brain-dispatcher / message-router 已有 `@@` 解析能力，自动拆包走 P2P orchestrator。

## 身份识别

Agent 不需要知道自己是谁。CLI 自动检测：

**优先级：**
1. `$IMCODES_SESSION` 环境变量 — 通用，所有平台/运行时
2. `$TMUX_PANE` → 查 tmux session name — fallback，仅 tmux 环境

**`IMCODES_SESSION` 注入时机：**
- daemon 控制所有 agent 的启动命令（`buildLaunchCommand`），在启动时注入：
  ```bash
  IMCODES_SESSION=deck_sub_xxx claude --resume ...
  IMCODES_SESSION=deck_sub_xxx codex --session ...
  ```
- Transport (OpenClaw) — spawn 进程时传 env
- CC SDK 调用 — 调用方设 env
- Windows — env var 同样适用

## 实现链路

```
Agent (in session)
  → imcodes send CLI
    → reads $IMCODES_SESSION (or $TMUX_PANE fallback)
    → reads ~/.imcodes/hook-port
    → POST http://localhost:{port}/send
      → daemon hook-server handler:
        1. 验证 from session 存在
        2. 从 from 的 parentSession 找同域 siblings
        3. 按 label/type/name 解析 target
        4. mux.sendKeys 注入消息到 target pane
        5. 返回 { ok: true, target: "deck_sub_xxx" }
```

## Hook Server 新端点

### POST /send
```json
{
  "from": "deck_sub_xxx",       // CLI 自动填充
  "to": "Plan",                  // label / session name / agent type
  "message": "review this",     // 必选
  "files": ["src/api.ts"],      // 可选，注入为 @file 引用
  "context": "..."              // 可选，额外上下文
}
```

## 目标解析

同一 parentSession 下查找，优先级：
1. **label** 精确匹配（大小写不敏感）
2. **session name** 精确匹配（deck_sub_xxx）
3. **agent type** 匹配（claude-code / codex / gemini）— 多个匹配时报错
4. 找不到 → 返回错误 + 可用 session 列表

## 终端复用器抽象层（TerminalMux）

现有 `src/agent/tmux.ts` 直接调 tmux 命令，所有上层代码都耦合 tmux。
抽出统一接口，启动时自动检测系统可用的终端复用器（tmux / WezTerm），实例化对应实现。

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
src/agent/mux.ts              — interface + auto-detect + export singleton
src/agent/mux/tmux.ts         — tmux 实现（从现有 tmux.ts 迁移）
src/agent/mux/wezterm.ts      — WezTerm 实现
```

### 自动检测

```typescript
// src/agent/mux.ts
async function detect(): Promise<TerminalMux> {
  // 1. 检查 $IMCODES_MUX 环境变量（用户强制指定）
  // 2. which tmux → TmuxMux
  // 3. which wezterm → WezTermMux
  // 4. 都没有 → 报错退出
}

export const mux = await detect();
```

### 迁移路径

现有 `src/agent/tmux.ts` 导出的函数：
- `newSession()` → `mux.newSession()`
- `killSession()` → `mux.killSession()`
- `sessionExists()` → `mux.sessionExists()`
- `tmuxListSessions()` → `mux.listSessions()`
- `sendKeys()` → `mux.sendKeys()`
- `capturePane()` → `mux.capturePane()`
- `respawnPane()` → `mux.respawnPane()`
- `getPaneCwd()` → `mux.getPaneCwd()`
- `getPaneId()` → `mux.getPaneId()`
- `getPaneCommand()` → `mux.getPaneCommand()`

上层调用方（session-manager、subsession-manager、command-handler、brain-dispatcher 等）改为 `import { mux } from './mux.js'`，调用 `mux.xxx()` 而非直接 `import { sendKeys } from './tmux.js'`。

### WezTerm 对应命令

| 操作 | tmux | WezTerm CLI |
|------|------|------------|
| 新建 session | `tmux new-session -d -s name 'cmd'` | `wezterm cli spawn --new-window --window-name name -- cmd` |
| 关闭 session | `tmux kill-session -t name` | `wezterm cli kill-pane --pane-id id` |
| 列出 sessions | `tmux list-sessions -F '#S'` | `wezterm cli list --format json` |
| 发送按键 | `tmux send-keys -t name 'text' Enter` | `wezterm cli send-text --pane-id id 'text\n'` |
| 捕获输出 | `tmux capture-pane -t name -p` | `wezterm cli get-text --pane-id id` |
| 查进程 | `tmux list-panes -t name -F '#{pane_pid}'` | `wezterm cli list --format json` (含 pid) |

## 跨平台支持

| 平台 | 终端复用器 | 身份检测 | TerminalMux 实现 |
|------|-----------|---------|-----------------|
| Linux/macOS | tmux | $IMCODES_SESSION > $TMUX_PANE | TmuxMux |
| Windows | WezTerm | $IMCODES_SESSION | WezTermMux |
| Linux/macOS (alt) | WezTerm | $IMCODES_SESSION | WezTermMux |
| Transport (OC) | 无 | $IMCODES_SESSION | provider API (不走 mux) |
| CC SDK | 无 | $IMCODES_SESSION | SDK stdin pipe (不走 mux) |

## CLAUDE.md / Agent Prompt 集成

在项目的 CLAUDE.md 或 agent system prompt 中加入：

```markdown
## Inter-Agent Communication

To send a message to another agent session:
  imcodes send "<label>" "<message>"
  imcodes send "<label>" "<message>" --files file1.ts,file2.ts

Use `imcodes send --list` to see available sibling sessions.
```

## 实现阶段

### Phase 1: TerminalMux 抽象层 + Windows 支持
- [ ] 定义 `TerminalMux` interface（`src/agent/mux.ts`）
- [ ] 从 `tmux.ts` 迁移到 `src/agent/mux/tmux.ts` 实现
- [ ] 实现 `src/agent/mux/wezterm.ts`（WezTerm CLI）
- [ ] 自动检测逻辑（`$IMCODES_MUX` > which tmux > which wezterm）
- [ ] 迁移所有上层调用方：session-manager、subsession-manager、command-handler 等
- [ ] 给所有 agent driver 的 launch command 注入 `IMCODES_SESSION` env var

### Phase 2: imcodes send
- [ ] CLI: `imcodes send` 子命令（commander）
- [ ] Hook server: `POST /send` 端点
- [ ] 目标解析（label → session name）
- [ ] `mux.sendKeys()` 注入消息
- [ ] `imcodes send --list` 列出可用 sessions

### Phase 3: 增强
- [ ] `imcodes send --status` 查看 siblings 状态
- [ ] 结果回传（target 完成后通知 sender）
- [ ] Transport session 支持（通过 provider API，不走 mux）
- [ ] 支持附件/二进制文件传递
