# Agent Inter-Session Communication

## 目标

让 AI agent 在 session 内能主动给其他 session 发送消息/命令，实现 agent 间协作。
支持 P2P 命令发送 — agent 可以发起跨 session 的 P2P 讨论。

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

# 发起 P2P 讨论
imcodes p2p "Plan,Cx" "review this architecture" --files src/api.ts --rounds 2
imcodes p2p --all "discuss the migration plan" --mode review
```

大模型只需知道 `imcodes send` 和 `imcodes p2p` 命令，不需要了解自身身份或任何内部机制。

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
        4. tmux sendKeys 注入消息到 target pane
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

### POST /p2p
```json
{
  "from": "deck_sub_xxx",
  "targets": ["Plan", "Cx"],    // labels / "all"
  "message": "discuss this",
  "files": ["src/api.ts"],
  "mode": "review",             // audit | review | brainstorm | discuss
  "rounds": 2
}
```

## 目标解析

同一 parentSession 下查找，优先级：
1. **label** 精确匹配（大小写不敏感）
2. **session name** 精确匹配（deck_sub_xxx）
3. **agent type** 匹配（claude-code / codex / gemini）— 多个匹配时报错
4. 找不到 → 返回错误 + 可用 session 列表

## 跨平台支持

| 平台 | 终端复用器 | 身份检测 | sendKeys |
|------|-----------|---------|----------|
| Linux/macOS | tmux | $IMCODES_SESSION > $TMUX_PANE | tmux send-keys |
| Windows | WezTerm (规划中) | $IMCODES_SESSION | WezTerm CLI / ConPTY |
| Transport (OC) | 无 tmux | $IMCODES_SESSION | provider API |
| CC SDK | 无 tmux | $IMCODES_SESSION | SDK stdin pipe |

## CLAUDE.md / Agent Prompt 集成

在项目的 CLAUDE.md 或 agent system prompt 中加入：

```markdown
## Inter-Agent Communication

To send a message to another agent session:
  imcodes send "<label>" "<message>"
  imcodes send "<label>" "<message>" --files file1.ts,file2.ts

To start a P2P discussion:
  imcodes p2p "<label1>,<label2>" "<topic>" --rounds 2

Use `imcodes send --list` to see available sibling sessions.
```

## 实现阶段

### Phase 1: 基础 send（当前）
- [ ] 给所有 agent driver 的 launch command 注入 `IMCODES_SESSION` env var
- [ ] CLI: `imcodes send` 子命令（commander）
- [ ] Hook server: `POST /send` 端点
- [ ] 目标解析（label → session name）
- [ ] tmux sendKeys 注入

### Phase 2: P2P 命令发送
- [ ] CLI: `imcodes p2p` 子命令
- [ ] Hook server: `POST /p2p` 端点
- [ ] 复用现有 P2P orchestrator（`p2p-orchestrator.ts`）
- [ ] Agent 可主动发起多轮讨论

### Phase 3: 跨平台
- [ ] Windows WezTerm 集成
- [ ] Transport session 支持（通过 provider API）
- [ ] CC SDK 直接调用支持

### Phase 4: 增强
- [ ] `imcodes send --list` 列出可用 sessions
- [ ] `imcodes send --status` 查看 siblings 状态
- [ ] 结果回传（target 完成后通知 sender）
- [ ] 支持附件/二进制文件传递
