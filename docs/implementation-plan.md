# IM.codes Web Dashboard 实现计划

## 当前状态

**已完成：**
- CF Worker 部署在 `app.im.codes`（Hono + D1 + Durable Objects）
- GitHub OAuth 登录（JWT session）
- D1 表：users, platform_identities, api_keys, servers, channel_bindings, sessions 等
- Daemon CLI 已安装（start/stop/bind/status/send）
- Web 前端（Preact）：LoginPage, SessionTabs, TerminalView, SessionControls, NewSessionDialog
- WebSocket 终端串流（WsClient → DaemonBridge Durable Object）

**已发现的 Bug：**

| Bug | 影响 | 位置 |
|-----|------|------|
| `app.tsx` 把 `userId` 存为 `serverId`，用它连 WebSocket | WebSocket 立即失败 | `web/src/app.tsx` |
| `/api/bind/initiate` 无鉴权，从 body 拿 userId | 安全漏洞 | `worker/src/routes/bind.ts` |
| 浏览器连的 `/api/server/:id/ws` 是 daemon 端点 | 浏览器不是 viewer | `web/src/ws-client.ts` |
| `resolveAuth` 对 JWT 用户始终返回 `role: 'member'` | 服务器 owner 无法操作 | `worker/src/security/authorization.ts` |
| Daemon 未注册 `serverLink.onMessage()` | Web 命令无法到达 daemon | `src/daemon/lifecycle.ts` |
| 无终端内容推送 | Web 终端无数据 | `src/agent/status-poller.ts` |

---

## Phase 1: Auth + API Key 管理

> 无依赖，最先部署。完成后：用户可登录、生成 deck_xxx key。

### 1a. Worker: API Key CRUD 端点

**文件：`worker/src/routes/auth.ts`**

新增三个路由（需 requireAuth 中间件）：

- `POST /api/auth/user/me/keys` — 创建 API key
  - Body: `{ label?: string }`
  - 生成 `deck_${randomHex(32)}`，SHA-256 hash 存入 api_keys
  - 返回 `{ id, apiKey, label, createdAt }`

- `GET /api/auth/user/me/keys` — 列出 API keys
  - Query: `SELECT id, label, created_at, revoked_at FROM api_keys WHERE user_id = ?`
  - 返回 `{ keys: [...] }`（不含 raw key）

- `DELETE /api/auth/user/me/keys/:keyId` — 撤销 key
  - 验证 user_id 匹配
  - `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ?`

需在 `GET /api/auth/user/me` 同时接受 JWT 和 API key 认证（已实现）。

### 1b. Web: API 客户端

**新文件：`web/src/api.ts`**

封装 fetch + Bearer token 的通用请求工具。

### 1c. Web: 修复 AuthState + Dashboard

**文件：`web/src/app.tsx`**

- AuthState 从 `{ token, serverId, serverUrl }` 改为 `{ token, userId, baseUrl }`
- OAuth 回调后存 `{ token, userId, baseUrl: location.origin }`
- 新增 `view` 状态：`'dashboard' | 'terminal'`，配合 `selectedServerId`
- dashboard 视图渲染 `<DashboardPage>`，terminal 视图渲染现有终端布局
- WebSocket 连接移到 terminal 视图，参数化 `selectedServerId`

**新文件：`web/src/pages/DashboardPage.tsx`**

- 接收 token, userId, baseUrl
- 渲染 `<ApiKeyManager>` 和 `<ServerList>`（Phase 2 实现，先 stub）
- 挂载时调 `GET /api/auth/user/me` 验证 session，401 则 logout

**新文件：`web/src/components/ApiKeyManager.tsx`**

- 挂载时 `GET /api/auth/user/me/keys` 拉列表
- 表格展示：ID（截断）、label、创建时间、是否撤销
- "Generate Key" 按钮 → 可选填 label → `POST /api/auth/user/me/keys`
- 创建后高亮显示 raw key + Copy 按钮 + 警告"保存好，不会再显示"
- "Revoke" 按钮 → `DELETE /api/auth/user/me/keys/:id` → 刷新列表

### 验收标准

登录 → 看到 Dashboard → 点击 Generate Key → 看到 deck_xxx → 复制成功

---

## Phase 2: 设备列表

> 依赖 Phase 1（DashboardPage 已存在）。完成后：用户能看到已绑定设备。

### 2a. Worker: 设备列表端点

**文件：`worker/src/routes/server.ts`**

新增（需 requireAuth）：

- `GET /api/server` — 返回用户拥有的设备（路由挂载在 `/api/server`，路径为 `/`）
  - Query: `SELECT id, name, status, last_heartbeat_at, created_at FROM servers WHERE user_id = ?`
  - 团队设备：JOIN team_members 查询，合并去重
  - 返回 `{ servers: [...] }`

**文件：`worker/src/db/queries.ts`**

新增 `getServersByUserId(db, userId): Promise<DbServer[]>`

### 2b. Web: ServerList 组件

**新文件：`web/src/components/ServerList.tsx`**

- 挂载时 `GET /api/server`
- 卡片展示：名称、在线/离线状态（last_heartbeat_at 2 分钟内 + status）、创建时间
- 在线设备显示 "Connect" 按钮 → `onSelectServer(serverId)`
- 空状态："No devices yet. Run `imcodes bind <name>` to add one."

**文件：`web/src/pages/DashboardPage.tsx`**

- 加入 `<ServerList>` 组件
- `onSelectServer` 回调传给 app.tsx

**文件：`web/src/app.tsx`**

- `onSelectServer` 设置 `selectedServerId`，切换到 terminal 视图
- 侧栏加返回 Dashboard 按钮

### 验收标准

登录 → 看到设备列表（手动 bind 后）→ 选择设备 → 进入终端视图

---

## Phase 3: 修复 Bind 流程

> 依赖 Phase 1（API key 已存在）。完成后：用户能从 web 引导完成设备绑定。

### 3a. Worker: Bind 端点加鉴权

**文件：`worker/src/routes/bind.ts`**

- `POST /api/bind/initiate` 加 `requireAuth()` 中间件
- 从 `c.get('userId')` 取 userId，不从 body 取
- Body 只需 `{ serverName }`
- 更新 zod schema

### 3b. Daemon: 修复 bind flow

**文件：`src/bind/bind-flow.ts`**

- 移除 `userId: 'me'`
- Body 只发 `{ serverName }`
- Header 带 `Authorization: Bearer ${apiKey}`
- Worker 从 API key 认证提取 userId

### 3c. Web: Getting Started 引导

**新文件：`web/src/components/GettingStarted.tsx`**

当用户零设备 + 零 API key 时显示。步骤式引导：

1. **生成 API Key** — 内联按钮，生成后显示 key，进入步骤 2
2. **配置 CLI** — 显示可复制的 config（自动填入 baseUrl）：
   ```yaml
   server:
     cfWorkerUrl: https://app.im.codes
     apiKey: deck_xxxxx
   ```
   保存到 `~/.imcodes/config.yaml`
3. **安装并绑定**：
   ```bash
   npm i -g imcodes
   imcodes bind my-laptop
   ```
4. **启动 daemon**：
   ```bash
   imcodes start
   ```

每 5 秒轮询 `GET /api/server`，设备出现后自动跳转。

### 验收标准

登录 → 看到引导 → 生成 key → 按步骤 bind → 设备自动出现

---

## Phase 4: 终端实时串流

> 依赖 Phase 2+3。完成后：Web 能实时看到终端输出、发送消息。

### 4a. Daemon: 命令处理器

**文件：`src/daemon/lifecycle.ts`**

`serverLink.connect()` 后注册消息处理：
```typescript
serverLink.onMessage(async (msg) => {
  await handleServerCommand(msg, config);
});
```

**新文件：`src/daemon/command-handler.ts`**

处理 Web 转发过来的命令：
- `session.start` → startProject
- `session.stop` → stopProject
- `session.send` → sendKeys（发送文本到 tmux session）
- `terminal.subscribe` → 启动终端串流
- `terminal.unsubscribe` → 停止终端串流

### 4b. Daemon: 终端串流

**新文件：`src/daemon/terminal-streamer.ts`**

- 维护 `Map<string, string[]>` 记录每个 session 最后发送的行
- 订阅时启动 capture 循环，FPS = `config.daemon.streamFps`（10）
- 每 tick：`capturePane(sessionName)` → diff → 有变化则发送（daemon 侧用 `terminal_update`，DaemonBridge 归一化为 `terminal.diff` 转发给浏览器）：
  ```json
  { "type": "terminal_update", "diff": { "sessionName": "...", "timestamp": 123, "lines": [[0, "line content"], ...], "cols": 120, "rows": 40 } }
  ```
  lines 格式：`[lineIndex, content][]`（仅变化行）
- 无变化 2 秒后降至 `streamIdleFps`（1 FPS）
- 无订阅时停止循环

**文件：`src/agent/tmux.ts`**

新增 `getPaneSize(session)` — 获取 cols/rows。

### 4c. Worker: 浏览器 WebSocket 路由

**文件：`worker/src/routes/auth.ts`**

新增 ws-ticket 端点（见"协议与安全决策"章节）：
- `POST /api/auth/ws-ticket` — 需 Bearer JWT，返回 15s 一次性 ticket

**文件：`worker/src/routes/server.ts`**

新增：
- `GET /api/server/:id/terminal` — 浏览器 WebSocket（viewer）
  - 从 `?ticket=` query param 验证短期 ticket（15s 过期，一次性）
  - 验证 ticket 中的 `sid` 与 `:id` 一致
  - 用 `resolveServerRole` 确认用户有权访问该设备
  - 代理到 DaemonBridge 的 `/browser` 路径

**文件：`web/src/ws-client.ts`**

- 连接前先 `POST /api/auth/ws-ticket` 获取 ticket
- WebSocket 路径从 `/api/server/${serverId}/ws` 改为 `/api/server/${serverId}/terminal?ticket=${ticket}`

### 4d. DaemonBridge: 放开消息转发

**文件：`worker/durable-objects/DaemonBridge.ts`**

当前只转发 `terminal_update` 和 `outbound` 类型。改为转发所有 daemon 消息到 browser sockets：
```typescript
for (const bs of this.browserSockets) {
  try { bs.send(data); } catch { this.browserSockets.delete(bs); }
}
```

### 4e. Worker: 修复权限判断

**文件：`worker/src/security/authorization.ts`**

新增 `resolveServerRole(c, serverId, userId)`:
- 查 servers 表，owner 直接返回 `'owner'`
- 有 team_id 则查 team_members 返回对应角色
- 否则 `'unauthenticated'`

**文件：`worker/src/routes/session-mgmt.ts`**

用 `resolveServerRole` 替代通用的 `requireAuth`，确保 server owner 有权限操作。

### 4f. Daemon: Session 事件上报

**文件：`src/daemon/lifecycle.ts`**

Session 状态变化时通过 ServerLink 上报：
```json
{ "type": "session.event", "event": "started|stopped|error", "session": "deck_xxx_w1", "state": "running" }
```

### 验收标准

选设备 → 看到实时终端输出 → 在 Web 发消息 → 终端显示响应

---

## 依赖关系

```
Phase 1 (Auth + Keys)
  ├──→ Phase 2 (Server List)  ──→ Phase 4 (Live Terminal)
  └──→ Phase 3 (Fix Bind)     ──→ Phase 4 (Live Terminal)
```

## 协议与安全决策

### 终端消息协议（Finding #1 修复）

Daemon → Worker 发 `terminal_update`，DaemonBridge 归一化为 `terminal.diff` 再转发给浏览器。
Web 只处理 `terminal.diff`，不需要改动。

```
Daemon                   DaemonBridge              Browser
  │ terminal_update ──→    │ 归一化为               │
  │                        │ terminal.diff ──────→  │
```

DaemonBridge 转换逻辑（`durable-objects/DaemonBridge.ts`）：
```typescript
if (msg.type === 'terminal_update') {
  const browserMsg = { type: 'terminal.diff', diff: msg.diff };
  for (const bs of this.browserSockets) { bs.send(JSON.stringify(browserMsg)); }
}
```

Session 事件同理：daemon 发 `session_event`，DaemonBridge 转为 `session.event`。

### WebSocket Token（Finding #2 修复）

不直接在 `?token=` 传 24h JWT。新增短期 ticket 端点：

- `POST /api/auth/ws-ticket` — 需 Bearer JWT 认证
  - 生成 15 秒一次性 ticket（signed JWT，`{ sub: userId, type: 'ws-ticket', sid: serverId }`）
  - 返回 `{ ticket }`

- 浏览器连接 WebSocket 时：
  1. 先 `POST /api/auth/ws-ticket` 获取 ticket
  2. 连接 `wss://app.im.codes/api/server/:id/terminal?ticket=<15s-ticket>`
  3. DaemonBridge 验证 ticket（一次性，15s 过期）

实现位置：
- 端点：`worker/src/routes/auth.ts`
- 验证：`worker/src/routes/server.ts` 的 terminal 路由
- Web 调用：`web/src/ws-client.ts` connect 前请求 ticket

### 路由路径（Finding #3 修复）

统一用单数 `/api/server`：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/server` | GET | 列出当前用户的所有设备 |
| `/api/server/:id` | GET | 获取单台设备详情 |
| `/api/server/:id/ws` | GET | Daemon WebSocket（升级） |
| `/api/server/:id/terminal` | GET | 浏览器 WebSocket（升级） |
| `/api/server/:id/sessions` | GET | 设备的 session 列表 |

路由挂载不变（`index.ts` 已是 `/api/server`），端点定义在 `server.ts` 里加 `GET /` 即可。

### 权限矩阵（Finding #4 修复）

| 操作 | owner | team:admin | team:member | 非成员 |
|------|-------|------------|-------------|--------|
| 查看设备列表 | ✅ | ✅ | ✅ | ❌ |
| 查看终端 | ✅ | ✅ | ✅ | ❌ |
| 发送消息 | ✅ | ✅ | ✅ | ❌ |
| 启动/停止 session | ✅ | ✅ | ❌ | ❌ |
| 绑定/解绑设备 | ✅ | ❌ | ❌ | ❌ |
| 管理 API keys | ✅ (自己的) | — | — | — |

实现位置：`worker/src/security/authorization.ts` 新增 `resolveServerRole()`：

```typescript
export type ServerRole = 'owner' | 'admin' | 'member' | 'none';

export async function resolveServerRole(
  db: D1Database, serverId: string, userId: string
): Promise<ServerRole> {
  const server = await db.prepare(
    'SELECT user_id, team_id FROM servers WHERE id = ?'
  ).bind(serverId).first<{ user_id: string; team_id: string | null }>();
  if (!server) return 'none';
  if (server.user_id === userId) return 'owner';
  if (server.team_id) {
    const member = await db.prepare(
      'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?'
    ).bind(server.team_id, userId).first<{ role: string }>();
    if (member) return member.role as ServerRole;
  }
  return 'none';
}
```

`session-mgmt.ts` 用 `resolveServerRole` 检查权限：
- start/stop 需要 `owner | admin`
- send 需要 `owner | admin | member`

---

## 其他安全注意事项

1. **OAuth token 暴露** — 当前 GitHub 回调把 JWT 放在 URL query（浏览器历史可见）。后续改为 HTTP-only cookie 或授权码模式
2. **终端串流带宽** — 10 FPS 全量 capture 可能带宽过大，必须实现 line-level diff
3. **Bind 无鉴权** — Phase 3 修复前是安全漏洞，优先处理
