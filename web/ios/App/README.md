# iOS App

移动端离线语音的架构、音频会话启动/停止顺序、缓冲/算力上界、手势与验证要求见：
[移动端流式语音工程规范](../../docs/STREAMING_SPEECH_MOBILE_GUIDELINES.md)。

原生插件或模型更新需重新构建 iOS App，不能只发布 Web OTA。
Linux Swift 核心测试不等于 iOS AVFoundation 编译或真机声学/性能验证；
完整原生编译入口见 `.github/workflows/mobile-speech.yml`。
