# Mobile App 开发文档

将现有 Preact Web 客户端通过 Capacitor 打包为 iOS/Android App，支持用户自建服务器（默认 `https://app.imcodes.org`）。

## 设计决策

### Native 登录策略：Passkey 优先 + 密码兜底

**Passkey 不能作为唯一登录方式。** 原因：
- 没有 Google Play Services 的安卓（国内大量设备）WebAuthn API 直接不存在
- GitHub OAuth 需要自建用户自己注册 GitHub App、配 callback URL，太麻烦
- 每个自建服务器域名不同，无法在 app 里预注册 Associated Domains
- **审核合规**：审核员设备可能未开启 iCloud 钥匙串或 Face ID，必须提供传统登录。

**方案：运行时检测，自动降级**

```
系统浏览器弹窗 → 服务器登录页
  ├─ WebAuthn 可用 → Passkey 登录（优先）+ 密码登录链接（备选，审核必选）
  └─ WebAuthn 不可用 → 密码登录（自动降级）
```

**UI 要求**：即便检测到支持 Passkey，界面上也必须保留显眼的"用户名密码登录"入口，以方便审核员使用你提供的测试账号进行测试。

**App Store 合规：** 不使用第三方社交登录（GitHub OAuth 仅 Web 端），无需强制增加 Sign in with Apple。

### 自建服务器默认 admin 密码

**自建用户的首要需求是"跑起来就能用"，不是"先配一堆东西"。**

- 服务器首次启动时，如果 `users` 表为空，自动创建 admin 用户
- 默认密码：`imcodes`（或从环境变量 `DEFAULT_ADMIN_PASSWORD` 读取）
- 首次登录后**强制修改密码**（标记 `password_must_change = true`）

---

## 已完成任务

### Task 10: 密码登录 + 默认 admin ✅
- [x] 服务端：实现 `/api/auth/password/login` 和 `/api/auth/password/change`。
  - `server/src/routes/auth.ts` — scrypt 密码验证，IP/user 锁定，JWT 签发
  - `server/src/security/crypto.ts` — `hashPassword()` / `verifyPassword()` (scrypt)
  - `server/src/db/migrations/015_password_auth.sql` — users 表加 username/password_hash/display_name/password_must_change
- [x] 服务端：启动时自动初始化 admin 账号。
  - `server/src/index.ts` — `ensureDefaultAdmin()` 在 migrations 之后运行
  - 环境变量 `DEFAULT_ADMIN_PASSWORD` 控制默认密码
- [ ] 前端：NativeAuthBridge 增加密码登录表单，确保在 Passkey 环境下也可手动切换。

### Task 13: 账号删除功能 (P0 - Guideline 5.1.1(v)) ✅
- [x] 服务端：`DELETE /api/auth/user/me` 接口。
  - `server/src/routes/auth.ts` — 完整级联删除所有关联数据
- [x] 级联删除：passkey_credentials → api_keys → refresh_tokens → push_tokens → servers → channel_bindings → sessions → discussions → users
- [x] 前端：设置页 → 「删除账号」危险操作按钮 → 二次确认（输入 DELETE）→ 调用 API 并注销。
  - `web/src/components/DeleteAccount.tsx` — 新组件
  - `web/src/pages/DashboardPage.tsx` — 集成到设置页

### Task 17: ATS 安全配置与 HTTPS 强制要求 (P0) ✅
- [x] `Info.plist`：配置 `NSAppTransportSecurity` + `NSAllowsLocalNetworking`，仅允许 localhost HTTP。
- [x] 前端：`ServerSetupPage.tsx` 增加 HTTP 警告提示，使用 `http://` 非 localhost 地址时显示黄色警告。

### Task 12 & 14: 法律文本 ✅
- [x] `landing/privacy.html`: 数据存储、用户权利、删除账号、无第三方共享。
- [x] `landing/terms.html`: AI 免责、自建安全自负、MIT 开源协议。

### 额外完成: 语音输入保留已有文字 ✅
- [x] `web/src/components/VoiceOverlay.tsx` — 新增 `initialText` prop，打开时保留聊天框文字
- [x] `web/src/components/SessionControls.tsx` — 传递当前输入文字到 VoiceOverlay

---

## 待完成

### Task 10 剩余: Native 端密码登录 UI (P0 — 审核 blocker) ✅

- [x] `web/src/pages/LoginPage.tsx` — 密码登录按钮从 `!isNative()` 块中拆出，GitHub OAuth 保留在 `!isNative()` 内
- [x] 服务端 `POST /api/auth/password/login` 支持 `native: true` 参数，签发 API key（同 passkey native 流程）
- [x] Native 端密码登录流程：`passwordLogin(native: true)` → 获取 API key → `storeAuthKey()` → `configureApiKey()` → 进入主界面
- [x] `passwordMustChange` 流程在 Native 端可用（API key 在 login 阶段已存储，change password 后调用 `/me` 获取 userId 完成登录）
- [x] i18n：全部 7 个 locale 文件已包含密码登录相关 key

### Task 18: 清理 Debug 代码 (P1) ✅

- [x] `web/src/pages/LoginPage.tsx` — `[DEBUG]` 前缀已去掉，改用 `t('login.passkey_error')` 本地化错误提示

### Task 15: App Store Connect 配置 (P2 — 提交必填)

| 项目 | 内容 | 状态 |
|------|------|------|
| 隐私政策 URL | `https://im.codes/privacy.html` (包含删除账号声明) | [ ] 在 App Store Connect 填写 |
| 服务条款 URL | `https://im.codes/terms.html` | [ ] 在 App Store Connect 填写 |
| 审核备注 | 告知审核员如何使用 Passkey 注册，并提供一组测试用的用户名/密码 | [ ] 填写 |
| 隐私标签 | **Identifiers (User ID, Device ID)** 必须勾选 **"Linked to User"** | [ ] 勾选 |
| App 分类 | Developer Tools / Utilities | [ ] 选择 |

### Task 19: Store Assets 素材 (P2 — 提交必填)

- [ ] App 图标 `icon-1024.png` (1024×1024, 无 alpha) — 确认已放入 `web/store-assets/`
- [ ] iPhone 6.7" 截图 (1290×2796) — 至少 3 张
- [ ] iPhone 5.5" 截图 (1242×2208) — 至少 3 张
- [ ] iPad Pro 12.9" 截图 (2048×2732) — 如支持 iPad
- [ ] App 名称、副标题、描述、关键词 — 中英文
- [ ] `web/store-assets/README.md` 中确认清单完整

### Task 20: 构建与签名 (P2 — 提交前)

- [ ] Xcode 签名配置：Bundle ID、Provisioning Profile、Distribution Certificate
- [ ] `capacitor.config.ts` 中 `appId` / `appName` 确认正确
- [ ] 执行 `web/scripts/build-mobile.sh ios` 完整构建无报错
- [ ] Archive → 上传到 App Store Connect
- [ ] TestFlight 内测验证通过后再提交审核

---

## App Store Preflight 扫描报告 (2026-03-22)

### ❌ 必须修复 — 不修必被拒 (2)

| # | Guideline | 问题 | 文件 | 修复方案 | 状态 |
|---|-----------|------|------|----------|------|
| 1 | 5.1.1 | 缺少 `PrivacyInfo.xcprivacy` 隐私清单 | `web/ios/App/App/` (不存在) | 创建清单，声明 `NSPrivacyAccessedAPICategoryUserDefaults` (CA92.1)，加入 Copy Bundle Resources | [ ] |
| 2 | 5.1.1(i) | App 内无隐私政策链接 | 全局 — 无 URL | Settings 页或登录页加隐私政策链接，App Store Connect 也要填 | [ ] |

### ⚠️ 需关注 — 有风险 (7)

| # | Guideline | 问题 | 风险 | 状态 |
|---|-----------|------|------|------|
| 3 | 4.8 | Sign in with Apple | native 不提供第三方登录，不强制。需确认 `isNative()` 可靠隐藏 GitHub 按钮 | [ ] 确认 |
| 4 | 5 (China) | UI 含 AI 品牌名 (Claude/Gemini/Codex) | 中国区可能被拒，建议不在中国区上架或动态隐藏 | [ ] 决策 |
| 5 | 4.2 | WebView wrapper 风险 | 审核备注里说明原生功能（推送、语音识别、生物认证、OTA） | [ ] 审核备注 |
| 6 | 2.4.5(i) | Push 通知插件装了但无 `.entitlements` 文件 | 添加 entitlements 或移除插件 | [ ] |
| 7 | 5.1.1(v) | 账号删除 — native 端清理 | 确认 `Preferences.clear()` 在 native 清理到位 | [ ] 验证 |
| 8 | 2.5.14 | 麦克风/语音识别权限 | 确认实际有使用且描述准确 | [ ] 验证 |
| 9 | 5.1.1(ii) | 相机/相册权限 | 如未使用需从 Info.plist 删除 | [ ] 验证 |

### ✅ 已通过 (12)

- App 名称 (< 30字符, 无商标) ✅
- Apple 商标合规 (5.2.5) ✅
- 无竞品平台名 (2.3.1) ✅
- 账号删除功能 (5.1.1(v)) ✅
- 数据最小化 (5.1.1(iii)) ✅
- 无多余 entitlements ✅
- AI 合规 — 无误导声明 (1.1.6) ✅
- AI 合规 — 无品牌抢注 (2.3.7, 5.2.5) ✅
- IPv6 兼容 (2.5.5) ✅
- ATS 安全配置 ✅
- 部署目标 iOS 15.0 ✅
- Universal device family ✅

---

## 2026-03-22 进度总结

### 今日已完成

- ✅ GitHub/GitLab repo provider 集成测试 (facebook/react, microsoft/vscode, gitlab-org/gitlab, fdroid/fdroidclient)
- ✅ `gh api` listBranches jq null date 崩溃修复
- ✅ Repo 按钮不显示 — 修复 5 层问题：消息格式 normalize、rate limit 豁免、错误处理、reconnect 广播、RepoPage 字段映射
- ✅ 密码登录 UI (web + native) + 强制改密码流程
- ✅ Admin 面板：用户管理 (approve/disable/delete) + 注册开关 + 审批开关
- ✅ Settings 页面：改密码 + 显示名编辑
- ✅ 安全审计 + 修复：disabled 用户登录封堵、refresh token 状态检查、注册端点管控、admin 不可删/禁、凭证级联删除
- ✅ 22 个 admin 集成测试 (真实 PostgreSQL via testcontainers)
- ✅ Docker Compose 一键部署方案 (Caddy 自动 SSL + Watchtower 自动更新)
- ✅ kr.codedeck.org 韩国反代节点 + im.zhinet.work 中国部署
- ✅ P2P prompt 优化 + heading 快速完成检测
- ✅ 轻量 native passkey 页面 (< 5KB, 不加载 SPA)
- ✅ 慢网络黑屏修复 (REST 5s timeout + WS 5s fallback + 全屏 connecting 指示器)
- ✅ App Store Preflight 扫描

### 待处理优先级

1. **P0**: `PrivacyInfo.xcprivacy` + 隐私政策链接 (App Store 必须)
2. **P0**: Push 通知 entitlements
3. **P1**: 审核备注 (原生功能说明 + 测试账号)
4. **P2**: Store Assets 截图 + 元数据
