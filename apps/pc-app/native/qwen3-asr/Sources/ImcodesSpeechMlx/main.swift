import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import Metal
import Qwen3ASR

private let outputLock = NSLock()

func emitJson(_ dict: [String: Any]) {
    outputLock.lock()
    defer { outputLock.unlock() }
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}

func currentArch() -> String {
    #if arch(arm64)
    return "arm64"
    #elseif arch(x86_64)
    return "x86_64"
    #else
    return "unknown"
    #endif
}

func hasAvailableMetallib() -> Bool {
    let fm = FileManager.default
    var searchDirs: [URL] = []
    if let execURL = Bundle.main.executableURL?.resolvingSymlinksInPath() {
        searchDirs.append(execURL.deletingLastPathComponent())
    }
    if let arg0 = CommandLine.arguments.first, !arg0.isEmpty {
        let argURL = URL(fileURLWithPath: arg0).resolvingSymlinksInPath()
        searchDirs.append(argURL.deletingLastPathComponent())
    }
    for dir in searchDirs {
        let candidates = [
            dir.appendingPathComponent("mlx.metallib"),
            dir.appendingPathComponent("Resources/mlx.metallib"),
            dir.appendingPathComponent("default.metallib"),
            dir.appendingPathComponent("Resources/default.metallib"),
            dir.appendingPathComponent("mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib"),
        ]
        if candidates.contains(where: { fm.isReadableFile(atPath: $0.path) }) {
            return true
        }
    }
    return false
}

func probePayload() -> [String: Any] {
    #if arch(arm64)
    let device = MTLCreateSystemDefaultDevice()
    let hasDevice = device != nil
    let hasMetallib = hasAvailableMetallib()
    return [
        "mlxSupported": hasDevice && hasMetallib,
        "metalSupported": hasDevice,
        "metallibAvailable": hasMetallib,
        "arch": currentArch(),
        "metalDevice": device?.name as Any? ?? NSNull(),
    ]
    #else
    return [
        "mlxSupported": false,
        "metalSupported": false,
        "metallibAvailable": false,
        "arch": currentArch(),
        "metalDevice": NSNull(),
    ]
    #endif
}

func requestMicIfNeeded() -> AVAuthorizationStatus {
    let current = AVCaptureDevice.authorizationStatus(for: .audio)
    if current != .notDetermined {
        return current
    }
    let sem = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + .seconds(30))
    return AVCaptureDevice.authorizationStatus(for: .audio)
}

private func audioDeviceTransportType(_ deviceID: AudioDeviceID) -> UInt32? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var transport: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &transport)
    return status == noErr ? transport : nil
}

private func physicalTransportPriority(_ transport: UInt32) -> Int? {
    switch transport {
    case kAudioDeviceTransportTypeBuiltIn:
        return 0
    case kAudioDeviceTransportTypeUSB:
        return 1
    case kAudioDeviceTransportTypeThunderbolt:
        return 2
    case kAudioDeviceTransportTypeDisplayPort:
        return 3
    case kAudioDeviceTransportTypeHDMI:
        return 4
    case kAudioDeviceTransportTypePCI:
        return 5
    case kAudioDeviceTransportTypeFireWire:
        return 6
    case kAudioDeviceTransportTypeAVB:
        return 7
    default:
        return nil
    }
}

private func isAudioDeviceAlive(_ deviceID: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsAlive,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var alive: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &alive)
    return status == noErr && alive != 0
}

private func audioDeviceInputChannelCount(_ deviceID: AudioDeviceID) -> Int {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &dataSize) == noErr,
          dataSize >= UInt32(MemoryLayout<AudioBufferList>.size) else {
        return 0
    }
    let raw = UnsafeMutableRawPointer.allocate(
        byteCount: Int(dataSize),
        alignment: MemoryLayout<AudioBufferList>.alignment
    )
    defer { raw.deallocate() }
    var size = dataSize
    guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, raw) == noErr else {
        return 0
    }
    let abl = raw.assumingMemoryBound(to: AudioBufferList.self)
    return UnsafeMutableAudioBufferListPointer(abl).reduce(0) { $0 + Int($1.mNumberChannels) }
}

private func isPhysicalInputDevice(_ deviceID: AudioDeviceID) -> Int? {
    guard deviceID != kAudioObjectUnknown,
          isAudioDeviceAlive(deviceID),
          audioDeviceInputChannelCount(deviceID) > 0,
          let transport = audioDeviceTransportType(deviceID) else {
        return nil
    }
    return physicalTransportPriority(transport)
}

private func audioDeviceStringProperty(_ deviceID: AudioDeviceID, selector: AudioObjectPropertySelector) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &value)
    guard status == noErr, let cfStr = value?.takeRetainedValue() else {
        return nil
    }
    return cfStr as String
}

private func transportTypeName(_ transport: UInt32?) -> String {
    guard let transport else { return "other" }
    switch transport {
    case kAudioDeviceTransportTypeBuiltIn:
        return "builtin"
    case kAudioDeviceTransportTypeUSB:
        return "usb"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE:
        return "bluetooth"
    case kAudioDeviceTransportTypeThunderbolt:
        return "thunderbolt"
    case kAudioDeviceTransportTypeDisplayPort:
        return "displayport"
    case kAudioDeviceTransportTypeHDMI:
        return "hdmi"
    case kAudioDeviceTransportTypePCI:
        return "pci"
    case kAudioDeviceTransportTypeFireWire:
        return "firewire"
    case kAudioDeviceTransportTypeAVB:
        return "avb"
    case kAudioDeviceTransportTypeAggregate:
        return "aggregate"
    case kAudioDeviceTransportTypeVirtual:
        return "virtual"
    default:
        return "other"
    }
}

private func allAudioDeviceIDs() -> [AudioDeviceID] {
    let systemObject = AudioObjectID(kAudioObjectSystemObject)
    var devicesAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &devicesAddr, 0, nil, &dataSize) == noErr,
          dataSize > 0 else {
        return []
    }
    let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.stride
    var deviceIDs = [AudioDeviceID](repeating: kAudioObjectUnknown, count: count)
    var mutableSize = dataSize
    guard AudioObjectGetPropertyData(systemObject, &devicesAddr, 0, nil, &mutableSize, &deviceIDs) == noErr else {
        return []
    }
    return deviceIDs
}

private func defaultInputDeviceID() -> AudioDeviceID {
    let systemObject = AudioObjectID(kAudioObjectSystemObject)
    var defaultAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var defaultID: AudioDeviceID = kAudioObjectUnknown
    var defaultSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    if AudioObjectGetPropertyData(systemObject, &defaultAddr, 0, nil, &defaultSize, &defaultID) == noErr {
        return defaultID
    }
    return kAudioObjectUnknown
}

func listAliveInputDevices() -> [[String: Any]] {
    let defaultID = defaultInputDeviceID()
    var result: [[String: Any]] = []
    for deviceID in allAudioDeviceIDs() {
        guard deviceID != kAudioObjectUnknown,
              isAudioDeviceAlive(deviceID),
              audioDeviceInputChannelCount(deviceID) > 0,
              let uid = audioDeviceStringProperty(deviceID, selector: kAudioDevicePropertyDeviceUID)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !uid.isEmpty else {
            continue
        }
        let name = audioDeviceStringProperty(deviceID, selector: kAudioObjectPropertyName)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let transport = audioDeviceTransportType(deviceID)
        let isPhysical = transport.flatMap(physicalTransportPriority) != nil
        result.append([
            "uid": uid,
            "name": (name?.isEmpty == false ? name! : uid),
            "transport": transportTypeName(transport),
            "isDefault": deviceID == defaultID,
            "isPhysical": isPhysical,
        ])
    }
    return result
}

func bindAudioInputDevice(_ inputNode: AVAudioInputNode, deviceID: AudioDeviceID) {
    if let audioUnit = inputNode.audioUnit {
        var devID = deviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &devID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        if status == noErr {
            return
        }
        fputs("[imcodes-speech-mlx] AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice=\(deviceID)) failed: OSStatus=\(status)\n", stderr)
    } else {
        fputs("[imcodes-speech-mlx] inputNode.audioUnit unavailable for device \(deviceID)\n", stderr)
    }
    do {
        try inputNode.auAudioUnit.setDeviceID(deviceID)
    } catch {
        fputs("[imcodes-speech-mlx] auAudioUnit.setDeviceID(\(deviceID)) fallback failed: \(error.localizedDescription)\n", stderr)
    }
}

func resolveInputDeviceID(deviceUID: String?) -> AudioDeviceID? {
    if let raw = deviceUID?.trimmingCharacters(in: .whitespacesAndNewlines),
       !raw.isEmpty,
       raw.lowercased() != "auto" {
        for deviceID in allAudioDeviceIDs() {
            guard deviceID != kAudioObjectUnknown,
                  isAudioDeviceAlive(deviceID),
                  audioDeviceInputChannelCount(deviceID) > 0,
                  let uid = audioDeviceStringProperty(deviceID, selector: kAudioDevicePropertyDeviceUID),
                  uid == raw else {
                continue
            }
            return deviceID
        }
    }
    return selectPreferredPhysicalInputDeviceID()
}

func selectPreferredPhysicalInputDeviceID() -> AudioDeviceID? {
    let defaultID = defaultInputDeviceID()
    if isPhysicalInputDevice(defaultID) != nil {
        return defaultID
    }

    var best: (id: AudioDeviceID, priority: Int)?
    for deviceID in allAudioDeviceIDs() {
        guard let priority = isPhysicalInputDevice(deviceID) else { continue }
        if best == nil || priority < best!.priority {
            best = (deviceID, priority)
        }
    }
    return best?.id
}

func joinTranscriptSegments(_ committed: String, _ active: String) -> String {
    let lhs = committed.trimmingCharacters(in: .whitespacesAndNewlines)
    let rhs = active.trimmingCharacters(in: .whitespacesAndNewlines)
    if lhs.isEmpty { return rhs }
    if rhs.isEmpty { return lhs }
    let lastScalar = lhs.unicodeScalars.last
    let firstScalar = rhs.unicodeScalars.first
    let needsSpace: Bool = {
        guard let l = lastScalar, let r = firstScalar else { return false }
        let asciiWord: (UnicodeScalar) -> Bool = { s in
            (s.value >= 0x30 && s.value <= 0x39)
                || (s.value >= 0x41 && s.value <= 0x5A)
                || (s.value >= 0x61 && s.value <= 0x7A)
        }
        return asciiWord(l) && asciiWord(r)
    }()
    return needsSpace ? "\(lhs) \(rhs)" : "\(lhs)\(rhs)"
}

final class QwenStreamingSession {
    private let sampleRate = 16_000
    private let strideSamples = 32_000 // 2.0s stride
    private let maxSegmentSamples = 216_000 // 13.5s bounded segment
    private let rollbackTokenCount = 5

    private let audioEngine = AVAudioEngine()
    private let lock = NSLock()
    private let decodeQueue = DispatchQueue(label: "com.imcodes.pc-app.qwen3asr", qos: .userInteractive)
    private let workSignal = DispatchSemaphore(value: 0)
    private let doneSemaphore = DispatchSemaphore(value: 0)

    private var pendingSamples: [Float] = []
    private var activeSegment: [Float] = []
    private var lastDecodedCount = 0
    private var committedText = ""
    private var activeText = ""
    private var confirmedTokens: [Int32] = []
    private var lastEmittedText = ""
    private var lastLevelEmit = Date.distantPast
    private var stopRequested = false
    private var aborted = false
    private var finished = false

    func run(modelDir: URL, variant: String, localeTag: String?, deviceUID: String?) -> Int32 {
        #if !arch(arm64)
        emitJson(["type": "error", "code": "mlx_unsupported", "message": "Qwen3-ASR requires Apple Silicon"])
        return 1
        #else
        guard MTLCreateSystemDefaultDevice() != nil else {
            emitJson(["type": "error", "code": "mlx_unsupported", "message": "Metal GPU device unavailable"])
            return 1
        }
        guard hasAvailableMetallib() else {
            emitJson(["type": "error", "code": "mlx_unsupported", "message": "MLX Metal shader library (mlx.metallib) not found"])
            return 1
        }
        #endif

        let micStatus = requestMicIfNeeded()
        guard micStatus == .authorized else {
            emitJson(["type": "error", "code": "permission_denied", "target": "mic"])
            return 1
        }

        let modelId = variant == "1.7b"
            ? "aufklarer/Qwen3-ASR-1.7B-MLX-4bit"
            : "aufklarer/Qwen3-ASR-0.6B-MLX-4bit"
        let hotwordsText = ((try? String(contentsOf: modelDir.appendingPathComponent("hotwords.txt"), encoding: .utf8)) ?? "")
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let hotwords: String? = hotwordsText.isEmpty ? nil : hotwordsText.joined(separator: ", ")
        let language = Qwen3ASRModel.resolveLanguage(localeTag)

        var loadedModel: Qwen3ASRModel?
        var loadError: Error?
        let loadSem = DispatchSemaphore(value: 0)
        decodeQueue.async {
            do {
                loadedModel = try Qwen3ASRModel.loadLocal(from: modelDir, modelId: modelId)
            } catch {
                loadError = error
            }
            loadSem.signal()
        }
        loadSem.wait()

        guard let model = loadedModel else {
            emitJson([
                "type": "error",
                "code": "model_load_failed",
                "message": loadError?.localizedDescription ?? "Failed to load Qwen3-ASR model",
            ])
            return 1
        }

        let inputNode = audioEngine.inputNode
        if let targetInputID = resolveInputDeviceID(deviceUID: deviceUID) {
            bindAudioInputDevice(inputNode, deviceID: targetInputID)
        }
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
            emitJson(["type": "error", "code": "no_audio_input"])
            return 1
        }

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(sampleRate),
            channels: 1,
            interleaved: false
        ), let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            emitJson(["type": "error", "code": "audio_format_failed"])
            return 1
        }

        inputNode.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.appendAudioBuffer(buffer, converter: converter, targetFormat: targetFormat)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            emitJson([
                "type": "error",
                "code": "audio_engine_failed",
                "message": error.localizedDescription,
            ])
            return 1
        }

        emitJson(["type": "start"])

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine(strippingNewline: true) {
                if line == "stop" || line == "abort" {
                    self?.stop(abort: line == "abort")
                    return
                }
            }
            self?.stop(abort: false)
        }

        decodeQueue.async { [weak self] in
            self?.workerLoop(model: model, language: language, hotwords: hotwords)
        }

        _ = doneSemaphore.wait(timeout: .distantFuture)
        return 0
    }

    private func appendAudioBuffer(
        _ buffer: AVAudioPCMBuffer,
        converter: AVAudioConverter,
        targetFormat: AVAudioFormat
    ) {
        let ratio = targetFormat.sampleRate / max(1.0, buffer.format.sampleRate)
        let capacity = AVAudioFrameCount(max(64, Int(ceil(Double(buffer.frameLength) * ratio)) + 16))
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var error: NSError?
        var consumed = false
        converter.convert(to: outBuffer, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        if error != nil { return }
        guard let channelData = outBuffer.floatChannelData?[0] else { return }
        let frameCount = Int(outBuffer.frameLength)
        guard frameCount > 0 else { return }

        var samples = [Float](repeating: 0, count: frameCount)
        var sumSquares: Float = 0
        for i in 0..<frameCount {
            let s = channelData[i]
            samples[i] = s
            sumSquares += s * s
        }

        let now = Date()
        lock.lock()
        let shouldEmitLevel = !stopRequested && !aborted && now.timeIntervalSince(lastLevelEmit) >= 0.09
        if shouldEmitLevel {
            lastLevelEmit = now
        }
        if !stopRequested && !aborted {
            pendingSamples.append(contentsOf: samples)
        }
        let shouldWake = !pendingSamples.isEmpty
        lock.unlock()

        if shouldEmitLevel {
            let rms = sqrt(sumSquares / Float(frameCount))
            emitJson(["type": "level", "value": min(1.0, Double(rms * 4.0))])
        }
        if shouldWake {
            workSignal.signal()
        }
    }

    private func workerLoop(model: Qwen3ASRModel, language: String?, hotwords: String?) {
        let expectLangHeader = language == nil
        while true {
            _ = workSignal.wait(timeout: .now() + .milliseconds(250))

            lock.lock()
            let isAborted = aborted
            let isStop = stopRequested
            if !pendingSamples.isEmpty {
                activeSegment.append(contentsOf: pendingSamples)
                pendingSamples.removeAll(keepingCapacity: true)
            }
            let currentLen = activeSegment.count
            let newCount = currentLen - lastDecodedCount
            lock.unlock()

            if isAborted {
                break
            }

            if newCount >= strideSamples || (isStop && currentLen > 0) {
                let isFinalPass = isStop
                let options = Qwen3DecodingOptions(
                    maxTokens: 192,
                    language: language,
                    context: hotwords
                )
                let segmentCopy: [Float]
                let prefixCopy: [Int32]
                lock.lock()
                segmentCopy = activeSegment
                prefixCopy = confirmedTokens
                lastDecodedCount = currentLen
                lock.unlock()

                if let result = try? model.transcribeSegmentWithCancellation(
                    audio: segmentCopy,
                    sampleRate: sampleRate,
                    options: options,
                    prefixTokens: prefixCopy,
                    checkCancellation: { [weak self] in
                        guard let self else { throw CancellationError() }
                        self.lock.lock()
                        let cancel = self.aborted
                        self.lock.unlock()
                        if cancel { throw CancellationError() }
                    }
                ) {
                    let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    activeText = text
                    if !isFinalPass {
                        confirmedTokens = model.safePrefixTokensForRollback(
                            result.tokens,
                            rollbackCount: rollbackTokenCount,
                            expectLanguageHeader: expectLangHeader
                        )
                    }
                    let combined = joinTranscriptSegments(committedText, activeText)
                    if !combined.isEmpty && (combined != lastEmittedText || isFinalPass) {
                        lastEmittedText = combined
                        emitJson([
                            "type": "result",
                            "text": combined,
                            "isFinal": isFinalPass,
                        ])
                    }
                }

                if !isFinalPass && currentLen >= maxSegmentSamples {
                    committedText = joinTranscriptSegments(committedText, activeText)
                    activeText = ""
                    confirmedTokens = []
                    lock.lock()
                    activeSegment.removeAll(keepingCapacity: true)
                    lastDecodedCount = 0
                    lock.unlock()
                }
            }

            if isStop {
                break
            }
        }

        model.unload()
        Qwen3ASRModel.clearMetalCache()
        finish()
    }

    func stop(abort: Bool) {
        lock.lock()
        if stopRequested && (!abort || aborted) {
            lock.unlock()
            return
        }
        stopRequested = true
        if abort {
            aborted = true
        }
        lock.unlock()

        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        workSignal.signal()
    }

    private func finish() {
        lock.lock()
        if finished {
            lock.unlock()
            return
        }
        finished = true
        lock.unlock()

        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        emitJson(["type": "end"])
        doneSemaphore.signal()
    }
}

let args = Array(CommandLine.arguments.dropFirst())
let cmd = args.first ?? "probe"

switch cmd {
case "probe":
    emitJson(probePayload())
    exit(0)
case "devices":
    if let data = try? JSONSerialization.data(withJSONObject: listAliveInputDevices(), options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    } else {
        print("[]")
        fflush(stdout)
    }
    exit(0)
case "listen":
    var modelDirPath: String?
    var variant = "0.6b"
    var localeTag: String?
    var deviceUID: String?
    var idx = 1
    while idx < args.count {
        switch args[idx] {
        case "--model-dir":
            if idx + 1 < args.count {
                modelDirPath = args[idx + 1]
                idx += 2
            } else {
                idx += 1
            }
        case "--variant":
            if idx + 1 < args.count {
                variant = args[idx + 1]
                idx += 2
            } else {
                idx += 1
            }
        case "--locale":
            if idx + 1 < args.count {
                localeTag = args[idx + 1]
                idx += 2
            } else {
                idx += 1
            }
        case "--device":
            if idx + 1 < args.count {
                deviceUID = args[idx + 1]
                idx += 2
            } else {
                idx += 1
            }
        default:
            idx += 1
        }
    }
    guard let modelDirPath, !modelDirPath.isEmpty else {
        emitJson(["type": "error", "code": "missing_model_dir"])
        exit(2)
    }
    let session = QwenStreamingSession()
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termSrc.setEventHandler { session.stop(abort: true) }
    termSrc.resume()
    let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    intSrc.setEventHandler { session.stop(abort: true) }
    intSrc.resume()
    let code = session.run(
        modelDir: URL(fileURLWithPath: modelDirPath, isDirectory: true),
        variant: variant,
        localeTag: localeTag,
        deviceUID: deviceUID
    )
    exit(code)
default:
    emitJson(["type": "error", "code": "unknown_command", "command": cmd])
    exit(2)
}
