import AVFoundation
import Capacitor
import SherpaOnnx
import SherpaOnnxC
import UIKit

/// The same Capacitor event contract as the existing voice input. No cloud service.
@objc(StreamingSpeechPlugin)
public class StreamingSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StreamingSpeechPlugin"
    public let jsName = "StreamingSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]
    private let worker = DispatchQueue(label: "com.imcodes.streaming-speech", qos: .userInitiated)
    private let lock = NSLock()
    private var generation: UInt64 = 0
    // Bounded audio work: do not accumulate hundreds of chunks behind a slow device.
    private let slots = DispatchSemaphore(value: 8)
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    // Only accessed on worker; queued PCM drains before the stop/final barrier.
    private var decoder: SpeechDecoder?
    private var decoderOwner: UInt64 = 0
    private var committed = ""
    private var lastText = ""

    public override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
    }
    deinit { NotificationCenter.default.removeObserver(self) }
    private func nextOwner() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1
        return generation
    }
    private func isCurrent(_ owner: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == owner
    }
    private var modelRoot: URL? { Bundle.module.resourceURL?.appendingPathComponent("models", isDirectory: true) }
    private var modelAvailable: Bool {
        guard let root = modelRoot else { return false }
        return ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"].allSatisfy {
            FileManager.default.isReadableFile(atPath: root.appendingPathComponent($0).path)
        }
    }
    @objc public func available(_ call: CAPPluginCall) { call.resolve(["available": modelAvailable]) }
    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { allowed in
            call.resolve(["speechRecognition": allowed ? "granted" : "denied"])
        }
    }
    @objc public func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else {
                call.reject("Speech requires a foreground app"); return
            }
            if self.engine?.isRunning == true { call.resolve(); return }
            guard AVAudioSession.sharedInstance().recordPermission == .granted else {
                call.reject("Microphone permission denied"); return
            }
            guard self.modelAvailable, let root = self.modelRoot else {
                call.reject("Offline speech model missing"); return
            }
            let owner = self.nextOwner()
            self.worker.async {
                guard self.isCurrent(owner) else { call.reject("Speech start cancelled"); return }
                let model = sherpaOnnxOnlineModelConfig(
                    tokens: root.appendingPathComponent("tokens.txt").path,
                    paraformer: sherpaOnnxOnlineParaformerModelConfig(
                        encoder: root.appendingPathComponent("encoder.int8.onnx").path,
                        decoder: root.appendingPathComponent("decoder.int8.onnx").path),
                    numThreads: 2)
                var config = sherpaOnnxOnlineRecognizerConfig(
                    featConfig: sherpaOnnxFeatureConfig(), modelConfig: model, enableEndpoint: true)
                guard let decoder = SpeechDecoder(config: &config) else {
                    call.reject("Offline speech model initialization failed"); return
                }
                self.decoder = decoder
                self.decoderOwner = owner
                self.committed = ""; self.lastText = ""
                DispatchQueue.main.async {
                    guard self.isCurrent(owner) else {
                        self.worker.async { if self.decoderOwner == owner { self.decoder = nil } }
                        call.reject("Speech start cancelled"); return
                    }
                    do {
                        let session = AVAudioSession.sharedInstance()
                        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
                        try session.setActive(true)
                        let engine = AVAudioEngine()
                        let input = engine.inputNode
                        let format = input.outputFormat(forBus: 0)
                        guard format.sampleRate > 0, format.channelCount > 0 else {
                            throw NSError(domain: "StreamingSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: "Microphone format unavailable"])
                        }
                        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
                              let converter = AVAudioConverter(from: format, to: mono) else {
                            throw NSError(domain: "StreamingSpeech", code: 2, userInfo: nil)
                        }
                        self.engine = engine
                        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: nil) { [weak self] buffer, _ in
                            self?.consume(buffer, owner: owner, converter: converter, format: mono)
                        }
                        self.tapInstalled = true
                        try engine.start()
                        self.notifyListeners("listeningState", data: ["status": "started"])
                        call.resolve()
                    } catch {
                        self.endCapture(nil)
                        call.reject("Offline speech could not start", nil, error)
                    }
                }
            }
        }
    }
    private func consume(_ buffer: AVAudioPCMBuffer, owner: UInt64, converter: AVAudioConverter, format: AVAudioFormat) {
        guard isCurrent(owner) else { return }
        guard slots.wait(timeout: .now()) == .success else {
            // Fail visibly, instead of silently dropping audio or growing memory.
            DispatchQueue.main.async {
                if self.isCurrent(owner) {
                    self.notifyListeners("recognitionError", data: ["message": "Offline speech processing overloaded"])
                    self.endCapture(nil)
                }
            }
            return
        }
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / buffer.format.sampleRate) + 16)
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { slots.signal(); return }
        var supplied = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return buffer
        }
        guard conversionError == nil, let channel = converted.floatChannelData?[0] else {
            slots.signal()
            DispatchQueue.main.async {
                if self.isCurrent(owner) { self.endCapture(nil) }
            }
            return
        }
        let count = Int(converted.frameLength)
        let samples = Array(UnsafeBufferPointer(start: channel, count: count))
        let power = samples.reduce(Float(0)) { $0 + $1 * $1 }
        let level = min(1, sqrt(power / Float(max(count, 1))) * 3)
        worker.async {
            defer { self.slots.signal() }
            guard self.decoderOwner == owner, let decoder = self.decoder else { return }
            self.notifyListeners("audioLevel", data: ["level": level])
            decoder.acceptWaveform(samples: samples)
            self.decodeAvailable(decoder)
            let text = self.join(self.committed, decoder.text.trimmingCharacters(in: .whitespacesAndNewlines))
            if text != self.lastText { self.emitText(text, final: false); self.lastText = text }
            if decoder.isEndpoint() { self.committed = text; decoder.reset() }
        }
    }
    private func decodeAvailable(_ decoder: SpeechDecoder) {
        while decoder.isReady() { decoder.decode() }
    }
    private func join(_ previous: String, _ text: String) -> String {
        if previous.isEmpty { return text }
        if text.isEmpty { return previous }
        let ascii = previous.unicodeScalars.last!.value < 128 && text.unicodeScalars.first!.value < 128
        return previous + (ascii ? " " : "") + text
    }
    private func emitText(_ text: String, final: Bool) {
        notifyListeners("partialResults", data: ["matches": [text], "isFinal": final])
    }
    @objc private func interrupted(_ notification: Notification) {
        if notification.name == AVAudioSession.interruptionNotification,
           let value = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
           value != AVAudioSession.InterruptionType.began.rawValue { return }
        DispatchQueue.main.async { self.endCapture(nil) }
    }
    @objc public func stop(_ call: CAPPluginCall) { DispatchQueue.main.async { self.endCapture(call) } }
    // Main-thread capture teardown; serial decoder flush precedes stopped and ACK.
    private func endCapture(_ call: CAPPluginCall?) {
        _ = nextOwner()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine?.stop(); engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        worker.async {
            if let decoder = self.decoder {
                decoder.acceptWaveform(samples: [Float](repeating: 0, count: 8000))
                decoder.inputFinished()
                self.decodeAvailable(decoder)
                self.emitText(self.join(self.committed, decoder.text.trimmingCharacters(in: .whitespacesAndNewlines)), final: true)
            }
            self.decoder = nil
            DispatchQueue.main.async {
                self.notifyListeners("listeningState", data: ["status": "stopped"])
                call?.resolve()
            }
        }
    }
}

// Unlike the upstream convenience wrapper, reject a failed native allocation
// instead of force-unwrapping it and crashing the app. Worker-thread owned.
private final class SpeechDecoder {
    let recognizer: OpaquePointer
    let stream: OpaquePointer
    init?(config: UnsafePointer<SherpaOnnxOnlineRecognizerConfig>) {
        guard let recognizer = SherpaOnnxCreateOnlineRecognizer(config) else { return nil }
        guard let stream = SherpaOnnxCreateOnlineStream(recognizer) else {
            SherpaOnnxDestroyOnlineRecognizer(recognizer); return nil
        }
        self.recognizer = recognizer; self.stream = stream
    }
    deinit {
        SherpaOnnxDestroyOnlineStream(stream)
        SherpaOnnxDestroyOnlineRecognizer(recognizer)
    }
    func acceptWaveform(samples: [Float]) {
        SherpaOnnxOnlineStreamAcceptWaveform(stream, 16000, samples, Int32(samples.count))
    }
    func inputFinished() { SherpaOnnxOnlineStreamInputFinished(stream) }
    func isReady() -> Bool { SherpaOnnxIsOnlineStreamReady(recognizer, stream) != 0 }
    func decode() { SherpaOnnxDecodeOnlineStream(recognizer, stream) }
    func reset() { SherpaOnnxOnlineStreamReset(recognizer, stream) }
    func isEndpoint() -> Bool { SherpaOnnxOnlineStreamIsEndpoint(recognizer, stream) != 0 }
    var text: String {
        guard let result = SherpaOnnxGetOnlineStreamResult(recognizer, stream) else { return "" }
        defer { SherpaOnnxDestroyOnlineRecognizerResult(result) }
        guard let text = result.pointee.text else { return "" }
        return String(cString: text)
    }
}
