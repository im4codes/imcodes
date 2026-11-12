# 移动端流式语音工程规范（Qwen3-ASR）

本规范把 M3 电脑端的五类避坑经验转化为移动端架构约束，**不是 M3 或手机性能实测报告**。
适用 iOS 原生壳、Android 原生壳以及 Web Mobile 的语音桥接/交互。

## 0. 现有架构与能力边界

```text
VoiceOverlay（编辑 / 手势 / stop 后发送）
  → VoiceInput（单会话 / generation 隔离 / 等待 final 与 stop ACK）
    → 新原生壳 StreamingSpeech
      → AVAudioEngine / AudioRecord → 有界 PCM inbox → 单串行 worker
      → 驻留 Qwen3-ASR-0.6B INT4 → 每步独立 offline stream → 累计文本快照
    → 旧原生壳：系统识别兼容桥
    → Web Mobile / 桌面浏览器：Web Speech API 兼容路径
```

代码入口：`web/src/components/VoiceInput.ts`、`VoiceOverlay.tsx`；原生代码在
`web/plugins/streaming-speech/{ios,android}/`。**当前没有 JS PCM 调度器，也没有 ASR WebSocket。**
原生 Qwen 是有界分段 offline 推理模拟的流式体验，不是具有 KV-cache/prefix 续写的流式 transducer。
所有 partial/final 都是**整段累计快照**，消费者必须替换当前语音区，不能逐条追加。

新壳仅加载构建脚本锁定 revision、SHA256 和尺寸的 0.6B INT4 资产；模型缺失必须失败，
不得自动下载大模型或悄悄切云端。旧壳系统识别和浏览器 Web Speech **不属于离线 Qwen 能力**，
可能受平台网络、识别时长和语言支持限制，不能声称“浏览器已离线运行 Qwen”。
如果产品要求 Web Mobile 也完全离线，必须另交付经验证的 Web 推理后端，不能用系统识别冒充。
原生插件/模型变更需要新 native build，不能用 Web OTA 替代。

## 1. Zero-Lag Buffer Drain 与 Single-Step Tail Flush

### 1.1 动态全量消费，不能固定小步追赶

音频回调只做转换、计量和有界入队，不执行推理。消费开始时，在同一把锁内转移**当时全部**积压：

```text
lock:
    chunk = buffer
    buffer = empty
unlock
if chunk is not empty:
    append all chunk to current acoustic window
    decode at most once (when cadence / VAD / capacity triggers)
```

禁止 `while buffer >= step: decode(buffer.take(step))`，也禁止每 100ms tap 排一个解码任务。
推理期间新到的音频属于**下一次全量 drain**，不得丢失，也不得同时启动第二个解码器。
“zero lag”指消除人为固定步长队列，不代表推理耗时为零，也不允许无界 PCM/无限排队。

当前实现：iOS `SpeechInbox` 只有一个 scheduled drain，`take()` 交换整个数组；
Android `CaptureSession.pollSamples()` 在监视器锁内合并并清空整个 deque。
两端保留每个捕获块的 speech 判定及尾部静音时长，不能用整批 RMS 把短促首字稀释为静音。

### 1.2 停录必须是一个最终屏障

顺序：停止接收 → 等待已接纳/正在转换的输入 → 等待在途 decode →
合并未消费 PCM 与窗口尾音 → **至多一次 final decode** → final 累计快照 → stopped → stop ACK。
已解码且没有新音频时不重复解码；空/纯静音录音不凭空推理。
禁止 Stop 后先按 1.5s 重放积压，再跑 final；不允许 stopped/ACK 抢在 final 前面。

iOS 用 capture lock 让入队与停录原子有序，串行 worker 完成 final；
Android Stop 等待 readerDone 后一次取走剩余输入。前一 session 的结果必须受 owner/generation 隔离，
不能覆盖重启、语言变化或关闭后的新编辑器内容。解码失败保留最后成功文本并报告错误。

### 1.3 资源上界与分段

- PCM：16kHz mono float32。inbox 上限 6.4s（102,400 samples / 409,600 bytes），溢出显式失败，不能静默丢字。
- 新音频步长 1.5s；iOS 正常窗口最多 4.5s，roll 保留 1.5s 音频重叠和 5 Character 文本回滚；
  Android 正常在 3s 容量/VAD 处提交分段。
- 一次积压允许暂时超过正常窗口，以保证整批一次解码、不丢已接纳 PCM；
  iOS decode 输入严格小于 4.5s + 6.4s，Android 严格小于 3s + 6.4s。
  不能把这个例外扩大为随录音长度增长的窗口。
- PCM/接缝状态有界；最终转写文本会随录音增长。输入转换/合并 O(n)，n 受上述上限约束；
  累计字符串发布 O(累计文本长度)，不是整段历史音频重放。

## 2. WebSocket 保活与禁止 60s 硬超时

本地 Qwen 管道没有 socket，不需要靠“空音频识别”保活，且客户端没有 60s 自动停录计时器。
长于 30s/60s 的语音只由用户、系统中断、资源失败结束；不能因为 elapsed 时间主动断开。
Web Speech 平台自身的 `onend` 限制不是应用的可配置超时，普通模式应如实显示暂停，
现有长笔记模式可按受限重启策略续录，不能承诺浏览器连续连接无限时长。
Web Mobile Stop 保留 `onresult` 到 `onend` 再清理，新会话等待旧 Stop；
仅停录阶段有 2s final-drain 兜底，缺失 `onend` 时保留最后文本并清理，不能挂住 UI。
这是停录故障收尾上界，**不是持续录音时长上限**。

未来若引入 ASR WebSocket：

- 原生/服务端优先使用 RFC 6455 Ping `0x9` / Pong `0xA` 控制帧；例如 20s ping、10s pong deadline，
  deadline 按最近一次探测重置，**不是从录音开始算 60s**。检测的是死连接，不是用户正在讲话的时长。
- 浏览器 WebSocket API 不暴露主动发送控制帧；由服务端发原生 ping、浏览器协议栈回 pong，
  或双方约定独立应用层 heartbeat。不要向浏览器编造 `socket.ping()`。
- 保活与 ASR 调度完全独立；静音期间不调用模型伪造心跳。断线显式报错，不能自动重放造成重复发送。
- 协议扩展必须对旧端缺省字段保持安全旧行为；重连需携带新 session owner，拒绝旧帧。

现有消息传输 WebSocket 与 ASR 是两个职责，不能为语音时长改动全局 WS 超时策略。

## 3. iOS 麦克风启动、防 Ducking 与瞬态底噪

启动顺序：

1. 检查前台/录音权限/模型可用；监听器先安装，decoder setup 先于 PCM 入队。
2. `VoiceInput` **暂停本页面 app-owned audio/video** 并取消 Web speech synthesis，之后才启动识别。
   暂停是淡出/暂停契约中的安全选项；不要改系统音量，不要在 Stop 后擅自恢复播放。
   页面外/native-owned 播放器须由其 owner 在启麦前自行暂停/淡出，本代码不能控制其它 app 的音乐。
3. 原生设 `.playAndRecord` + `.measurement`，options 包含 `.mixWithOthers`、`.defaultToSpeaker`，
   保留蓝牙输入支持；再 `setActive(true)`，安装 tap 并启动 engine。
   禁止 `.duckOthers`：它主动降低其他音频，不等于保护首字。
4. 将转换后的首 **1600 个 16kHz sample（100ms）** 当作本次捕获启动瞬态丢弃，
   即使它跨多个短 tap 也只丢这一段；不能每步/每个分段都丢 100ms。
   `started` 事件与 start ACK 等这 100ms 消费完才发出，避免 UI 过早提示讲话；
   warmup 期间 Stop 也必须结算 pending start，不能挂起。100ms 滤除不是声学首字无损保证，仍须实机检查。
5. Stop/后台/音频中断卸载 tap、停 engine、`setActive(false, .notifyOthersOnDeactivation)`；
   不自动重开麦克风。错误同样必须清理。

`mixWithOthers` 解决非混音类别激活导致的其它会话中断，不等于回声消除，也不能保证蓝牙路由不变。
外部音乐、扬声器/耳机/蓝牙、权限首次授权、快速启停和来电均需要真机验证。
旧壳使用已安装旧插件的配置；此轮新插件防护不会通过 Web OTA 修补旧二进制。

## 4. Touch / PTT / Double-Click

`VoiceOverlay` 内麦克风控制支持：

- 短按：点录/暂停，保留键盘 click 的可访问性；打开 overlay 仍沿用现有自动开始行为。
- 长按达到 350ms：Press-to-talk；暂停状态先开始，松手即停并保留最终尾字，不自动发送。
  pointer capture 防止移出按钮后漏掉松手；cancel/lost-capture 也停止，第二根手指不能干扰 owner。
- 两次有效点击间隔 ≤375ms（350–400ms 区间）：走现有 `handleSend`，先等待 final/stop，
  再提交一次。同一 session token 的并发调用共享整个 flush/commit Promise（不能只共用底层 stop），
  防止首个等待者提交后把发送等待者误判为 stale；取消/新录音不得复用旧 token 的 Promise。
  超过窗口仅执行普通点录。长按后的合成 click 被抑制，不能误触发送。
- 长笔记模式保持原有显式复核，双击不得绕过 review；关闭/卸载取消手势定时器。
- 不直接向 session transport 写消息；沿用 composer 的 accepted/pending/rejected 及重复发送保护。

## 5. 移动算力分级与发布门槛

| 项目 | 工程约束/目标 | 当前证据性质 |
| --- | --- | --- |
| 本地 Qwen 模型 | **仅 Qwen3-ASR-0.6B INT4**，锁定模型资产，不允许 1.7B/FP16 自动升级 | 构建资产与 native 配置契约测试 |
| 新音频步长 | **1.5–2.0s**，当前 1.5s；VAD/Stop 可提前收尾 | 原生核心/fixture 测试 |
| 中间步生成预算 | `max_new_tokens` / `maxNewTokens` **16–24**，当前 24；禁止无上限循环 | 两端配置 24，最终步也沿用 24 |
| 单步耗时 | 目标 **<500ms**（包含实际推理的设备测量，不是 mock） | **未进行手机实测，不能宣称达标** |
| 算力冗余 | 定义 `headroom = 1 - decodeWallTime / newAudioDuration`，须 **≥60%** | **未进行手机实测**；1.5s/500ms 对应约 66.7% |
| 并行/资源 | 一个 serial decoder，模型驻留，原生推理最多 2 threads，有界 inbox | host 核心/bridge 契约测试 |

不能把 500ms 实现成“500ms 超时就丢弃结果”。弱机积压仍须整批 drain；超过内存界限要显式失败，
不能换更大的模型、无界排队或假装成功。24-token 预算和积压大批次的转写完整性必须在设备语料上评估；
不能将合成 decoder 的“字没丢”当成真实模型长句准确率证明。

## 6. 验证与升级回归清单

自动验证（仓库根目录，Swift 编译器不在 `/usr/bin/swiftc` 时显式设置 `SWIFTC`）：

```sh
SWIFTC=/absolute/toolchain/usr/bin/swiftc npx vitest run test/native/mobile-streaming-speech-assets.test.ts --minWorkers=1 --maxWorkers=2
npx vitest run web/test/components/VoiceInput.test.ts web/test/components/VoiceOverlay.notepad.test.tsx web/test/voice-recognition-backend.test.ts web/test/voice-input-language.test.ts --minWorkers=1 --maxWorkers=2
npx tsc --noEmit
npm --prefix web run typecheck
```

测试执行生产 Swift 核心（不是 JS 重写）以及生产 Java 插件配合可控音频/模型 peer，覆盖：
全量 drain、64块上界/溢出、冷启动停录、在途 decode + 积压 stop 单步、重复 finish、100ms 跨 tap、
空音频/VAD/Unicode/重复词/长文本接缝、跨 owner、长录音无 60s 硬停、媒体暂停与手势。
编译器缺失会 skip Swift 核心测试；交付报告必须标明，不能把 skip 算 pass。

原生编译：`.github/workflows/mobile-speech.yml` 的 macOS iOS simulator job（prepare assets、Web build、
Capacitor sync、xcodebuild）是 AVFoundation/Capacitor/sherpa 链接验证；Linux Swift 核心编译不能替代它。

物理设备发布前：

- 30s、61s、120s 连续讲话；静音/弱音/中英日韩俄西、重复短词、尾部 <1.5s、最后 100ms；
- 推理变慢、冷模型初始化、接近/超过 6.4s 积压、在途 decode 时停录；
- iPhone 扬声器/有线/蓝牙，背景播放启麦，100ms 启动边界的首字，权限拒绝/恢复、来电/锁屏；
- 短按/PTT 移出松手/取消/双指/375ms 窗口两侧，重复发送抑制，笔记复核和草稿恢复；
- 同一 exact HEAD 的新 scoped build，记录设备/OS、模型 revision、单步 P50/P95/max、新音频长度、
  inbox 峰值、Stop→final 延迟、功耗/温升、转写完整性，再计算 headroom。

无已授权可用实机时，以上项应记“未测/发布前门槛”，不得声称“彻底杜绝所有手机声学问题”。

## 参考

- [Apple：mixWithOthers](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/mixwithothers)
- [Apple：duckOthers](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/duckothers)
- [RFC 6455 §5.5：控制帧](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5)
- [WebSocket 标准：Ping/Pong 与浏览器 API 边界](https://websockets.spec.whatwg.org/#ping-and-pong-frames)
