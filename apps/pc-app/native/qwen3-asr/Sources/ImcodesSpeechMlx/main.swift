import AudioToolbox
import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import IOKit
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

func isMacBookClamshellClosed() -> Bool {
    guard let matching = IOServiceMatching("IOPMrootDomain") else {
        return false
    }
    let service = IOServiceGetMatchingService(kIOMainPortDefault, matching)
    guard service != IO_OBJECT_NULL else {
        return false
    }
    defer { IOObjectRelease(service) }
    guard let prop = IORegistryEntryCreateCFProperty(
        service,
        "AppleClamshellState" as CFString,
        kCFAllocatorDefault,
        0
    ) else {
        return false
    }
    return (prop.takeRetainedValue() as? Bool) == true
}

private func isPhysicalInputDevice(_ deviceID: AudioDeviceID, excludeBuiltIn: Bool = false) -> Int? {
    guard deviceID != kAudioObjectUnknown,
          isAudioDeviceAlive(deviceID),
          audioDeviceInputChannelCount(deviceID) > 0,
          let transport = audioDeviceTransportType(deviceID) else {
        return nil
    }
    if excludeBuiltIn && transport == kAudioDeviceTransportTypeBuiltIn {
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

func resolveCaptureDevice(deviceUID: String?, clamshellClosed: Bool = isMacBookClamshellClosed()) -> AVCaptureDevice? {
    if let targetInputID = resolveInputDeviceID(deviceUID: deviceUID, clamshellClosed: clamshellClosed),
       let uid = audioDeviceStringProperty(targetInputID, selector: kAudioDevicePropertyDeviceUID)?
         .trimmingCharacters(in: .whitespacesAndNewlines),
       !uid.isEmpty,
       let matched = AVCaptureDevice(uniqueID: uid) {
        return matched
    }
    return AVCaptureDevice.default(for: .audio)
}

func resolveInputDeviceID(deviceUID: String?, clamshellClosed: Bool = isMacBookClamshellClosed()) -> AudioDeviceID? {
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
    return selectPreferredPhysicalInputDeviceID(clamshellClosed: clamshellClosed)
}

func selectPreferredPhysicalInputDeviceID(clamshellClosed: Bool = isMacBookClamshellClosed()) -> AudioDeviceID? {
    let defaultID = defaultInputDeviceID()
    if isPhysicalInputDevice(defaultID, excludeBuiltIn: clamshellClosed) != nil {
        return defaultID
    }

    var best: (id: AudioDeviceID, priority: Int)?
    for deviceID in allAudioDeviceIDs() {
        guard let priority = isPhysicalInputDevice(deviceID, excludeBuiltIn: clamshellClosed) else { continue }
        if best == nil || priority < best!.priority {
            best = (deviceID, priority)
        }
    }
    if let best {
        return best.id
    }
    if clamshellClosed,
       defaultID != kAudioObjectUnknown,
       isAudioDeviceAlive(defaultID),
       audioDeviceInputChannelCount(defaultID) > 0,
       audioDeviceTransportType(defaultID) != kAudioDeviceTransportTypeBuiltIn {
        return defaultID
    }
    return nil
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

func sanitizeAsrRepetitionLoop(_ text: String) -> String {
    let trimmedInput = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedInput.isEmpty { return "" }
    var chars = Array(text)
    if chars.count < 8 { return text }

    func isAsciiDigit(_ ch: Character) -> Bool {
        guard let scalar = ch.unicodeScalars.first, ch.unicodeScalars.count == 1 else { return false }
        return scalar.value >= 0x30 && scalar.value <= 0x39
    }

    func collapse(period: Int) -> Bool {
        let n = chars.count
        guard n >= period * 2 else { return false }
        var removeRanges: [(Int, Int)] = []
        if period == 1 {
            var runStart = 0
            for i in 1...n {
                if i < n && chars[i] == chars[runStart] { continue }
                let runLen = i - runStart
                let threshold = isAsciiDigit(chars[runStart]) ? 16 : 8
                if runLen >= threshold {
                    removeRanges.append((runStart, i))
                }
                runStart = i
            }
        } else {
            let minMatchLen = period * 4
            var matchLen = 0
            if period <= n {
                for i in period...n {
                    if i < n && chars[i] == chars[i - period] {
                        matchLen += 1
                        continue
                    }
                    if matchLen >= minMatchLen {
                        let runEnd = i
                        let runStart = runEnd - matchLen - period
                        let first = chars[runStart]
                        let isUniform = (1..<period).allSatisfy { chars[runStart + $0] == first }
                        if !isUniform {
                            if let last = removeRanges.last, runStart < last.1 {
                                if runEnd > last.1 {
                                    removeRanges[removeRanges.count - 1].1 = runEnd
                                }
                            } else {
                                removeRanges.append((runStart, runEnd))
                            }
                        }
                    }
                    matchLen = 0
                }
            }
        }
        if removeRanges.isEmpty { return false }
        var out: [Character] = []
        out.reserveCapacity(n)
        var cursor = 0
        for (start, end) in removeRanges {
            if cursor < start {
                out.append(contentsOf: chars[cursor..<start])
            }
            cursor = end
        }
        if cursor < n {
            out.append(contentsOf: chars[cursor..<n])
        }
        chars = out
        return true
    }

    var removedAny = false
    for _ in 0..<2 {
        var changedInRound = false
        if collapse(period: 1) {
            changedInRound = true
            removedAny = true
        }
        for period in 2...24 {
            if chars.count < period * 5 { break }
            if collapse(period: period) {
                changedInRound = true
                removedAny = true
            }
        }
        if !changedInRound { break }
    }

    if !removedAny { return text }
    let cleaned = String(chars).trimmingCharacters(in: .whitespacesAndNewlines)
    if cleaned.isEmpty { return "" }
    let hasMeaningful = cleaned.contains { $0.isLetter || $0.isNumber }
    return hasMeaningful ? cleaned : ""
}

private func readHotwords(from modelDir: URL) -> [String] {
    ((try? String(contentsOf: modelDir.appendingPathComponent("hotwords.txt"), encoding: .utf8)) ?? "")
        .split(whereSeparator: \.isNewline)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

private func mergeSessionHotwords(base: [String], requestHotwords: Any?) -> (context: String?, filterTerms: [String]) {
    var terms: [String] = []
    var seen = Set<String>()
    var totalChars = 0

    func appendTerm(_ raw: String) {
        guard terms.count < 60 else { return }
        let stripped = raw.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let cleaned = String(String.UnicodeScalarView(stripped))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        let bounded = cleaned.count > 64 ? String(cleaned.prefix(64)).trimmingCharacters(in: .whitespacesAndNewlines) : cleaned
        guard !bounded.isEmpty else { return }
        let key = bounded.lowercased()
        guard !seen.contains(key) else { return }
        let sepLen = terms.isEmpty ? 0 : 2
        guard totalChars + sepLen + bounded.count <= 1000 else { return }
        seen.insert(key)
        terms.append(bounded)
        totalChars += sepLen + bounded.count
    }

    if let rawString = requestHotwords as? String {
        for part in rawString.split(whereSeparator: { $0 == "," || $0 == "\n" || $0 == "\r" }) {
            appendTerm(String(part))
        }
    } else if let rawArray = requestHotwords as? [Any] {
        for item in rawArray {
            if let text = item as? String {
                appendTerm(text)
            }
        }
    }

    // Preserve legacy static hotwords.txt verbatim when no valid per-request hotwords are provided.
    if terms.isEmpty {
        return (base.isEmpty ? nil : base.joined(separator: ", "), base)
    }

    for part in base {
        appendTerm(part)
    }

    return (terms.isEmpty ? nil : terms.joined(separator: ", "), terms)
}

private func checkMlxRuntimeAvailable() -> Bool {
    #if !arch(arm64)
    emitJson(["type": "error", "code": "mlx_unsupported", "message": "Qwen3-ASR requires Apple Silicon"])
    return false
    #else
    guard MTLCreateSystemDefaultDevice() != nil else {
        emitJson(["type": "error", "code": "mlx_unsupported", "message": "Metal GPU device unavailable"])
        return false
    }
    guard hasAvailableMetallib() else {
        emitJson(["type": "error", "code": "mlx_unsupported", "message": "MLX Metal shader library (mlx.metallib) not found"])
        return false
    }
    return true
    #endif
}

private func loadMlxModel(modelDir: URL, variant: String, onQueue decodeQueue: DispatchQueue) -> Qwen3ASRModel? {
    let modelId = variant == "1.7b"
        ? "aufklarer/Qwen3-ASR-1.7B-MLX-4bit"
        : "aufklarer/Qwen3-ASR-0.6B-MLX-4bit"
    var loadedModel: Qwen3ASRModel?
    var loadError: Error?
    let loadSem = DispatchSemaphore(value: 0)
    emitJson(["type": "loading", "variant": variant])
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
        return nil
    }
    return model
}

private final class CaptureAudioDelegate: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let onSampleBuffer: (CMSampleBuffer) -> Void

    init(onSampleBuffer: @escaping (CMSampleBuffer) -> Void) {
        self.onSampleBuffer = onSampleBuffer
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        onSampleBuffer(sampleBuffer)
    }
}

// MARK: - Segmented Decode Engine (Pure Foundation)

private let kSpeechEnergyPeakThreshold: Float = 0.015
private let kSpeechEnergyWindowRmsThreshold: Float = 0.005

private func scanSpeechEnergyRange(
    _ samples: ArraySlice<Float>,
    sampleRate: Int,
    stopOnFirst: Bool
) -> (first: Int, last: Int)? {
    let count = samples.count
    guard count > 0 else { return nil }
    let rate = sampleRate > 0 ? sampleRate : 16_000
    let windowSamples = max(1, Int((Double(rate) * 0.05).rounded()))
    let rmsSqThreshold = Double(kSpeechEnergyWindowRmsThreshold) * Double(kSpeechEnergyWindowRmsThreshold)

    let base = samples.startIndex
    var firstIdx: Int? = nil
    var lastIdx = -1
    var firstAboveRmsThresh: Int? = nil
    var lastAboveRmsThresh = -1
    var windowSumSq = 0.0
    let rmsSampleThresh = Float(kSpeechEnergyWindowRmsThreshold)

    for offset in 0..<count {
        let s = samples[base + offset]
        let absS = abs(s)
        if absS >= rmsSampleThresh {
            if firstAboveRmsThresh == nil { firstAboveRmsThresh = offset }
            lastAboveRmsThresh = offset
        }
        if absS >= kSpeechEnergyPeakThreshold {
            if firstIdx == nil { firstIdx = offset }
            lastIdx = offset
            if stopOnFirst {
                return (firstIdx!, lastIdx)
            }
        }
        let d = Double(s)
        windowSumSq += d * d
        if offset >= windowSamples {
            let old = Double(samples[base + offset - windowSamples])
            windowSumSq -= old * old
            if windowSumSq < 0 { windowSumSq = 0 }
        }
        if offset + 1 >= windowSamples && (windowSumSq / Double(windowSamples)) >= rmsSqThreshold {
            let winStart = offset - windowSamples + 1
            if firstIdx == nil {
                if let firstAbove = firstAboveRmsThresh, firstAbove >= winStart {
                    firstIdx = firstAbove
                } else {
                    var tightened = winStart
                    for j in winStart...offset where abs(samples[base + j]) >= rmsSampleThresh {
                        tightened = j
                        break
                    }
                    firstIdx = tightened
                }
            }
            if lastAboveRmsThresh >= winStart && lastAboveRmsThresh > lastIdx {
                lastIdx = lastAboveRmsThresh
            }
            if stopOnFirst {
                return (firstIdx!, max(firstIdx!, lastIdx))
            }
        }
    }
    if count < windowSamples && (windowSumSq / Double(count)) >= rmsSqThreshold {
        if firstIdx == nil { firstIdx = firstAboveRmsThresh ?? 0 }
        if lastAboveRmsThresh > lastIdx {
            lastIdx = lastAboveRmsThresh
        } else if lastIdx < 0 {
            lastIdx = count - 1
        }
        return (firstIdx!, max(firstIdx!, lastIdx))
    }
    if let firstIdx, lastIdx >= firstIdx {
        return (firstIdx, lastIdx)
    }
    return nil
}

func hasSpeechEnergy(_ samples: [Float], sampleRate: Int = 16_000) -> Bool {
    return scanSpeechEnergyRange(samples[...], sampleRate: sampleRate, stopOnFirst: true) != nil
}

func trimSilenceEdgesWithRange(
    _ samples: [Float],
    sampleRate: Int = 16_000,
    padMs: Int = 250
) -> (samples: [Float], range: Range<Int>)? {
    let count = samples.count
    guard count > 0, let bounds = scanSpeechEnergyRange(samples[...], sampleRate: sampleRate, stopOnFirst: false) else {
        return nil
    }
    let rate = sampleRate > 0 ? sampleRate : 16_000
    let padSamples = max(0, Int((Double(rate) * Double(max(0, padMs)) / 1000.0).rounded()))
    let start = max(0, bounds.first - padSamples)
    let end = min(count, bounds.last + 1 + padSamples)
    if start == 0 && end == count {
        return (samples, 0..<count)
    }
    return (Array(samples[start..<end]), start..<end)
}

func trimSilenceEdges(_ samples: [Float], sampleRate: Int = 16_000, padMs: Int = 250) -> [Float] {
    return trimSilenceEdgesWithRange(samples, sampleRate: sampleRate, padMs: padMs)?.samples ?? []
}

func trimTrailingSilence(
    _ samples: [Float],
    fixedStart: Int,
    sampleRate: Int = 16_000,
    padMs: Int = 250
) -> [Float] {
    let count = samples.count
    let clampedStart = max(0, min(fixedStart, count))
    guard clampedStart < count,
          let bounds = scanSpeechEnergyRange(samples[clampedStart..<count], sampleRate: sampleRate, stopOnFirst: false) else {
        return []
    }
    let rate = sampleRate > 0 ? sampleRate : 16_000
    let padSamples = max(0, Int((Double(rate) * Double(max(0, padMs)) / 1000.0).rounded()))
    let end = min(count, clampedStart + bounds.last + 1 + padSamples)
    guard clampedStart < end else { return [] }
    if clampedStart == 0 && end == count {
        return samples
    }
    return Array(samples[clampedStart..<end])
}

private func isSupportedHotwordSymbol(_ ch: Character) -> Bool {
    switch ch {
    case "~", "`", "+", "=", "|", "<", ">", "$", "¥", "€", "£", "°", "^", "\u{2026}", "\u{2022}", "\u{00B7}":
        return true
    default:
        return false
    }
}

private func isHotwordHallucinationSeparator(_ ch: Character) -> Bool {
    return ch.isWhitespace || ch.isPunctuation || isSupportedHotwordSymbol(ch)
}

private func isHotwordSentenceEndChar(_ ch: Character) -> Bool {
    switch ch {
    case ".", "!", "?", "。", "！", "？", "\n", "\r", "\r\n", ";", "；":
        return true
    default:
        return false
    }
}

private func isHotwordWeakTrailingSepChar(_ ch: Character) -> Bool {
    if ch.isWhitespace { return true }
    switch ch {
    case ",", "，", "、", ":", "：", "-", "—", "–", "·", "•":
        return true
    default:
        return false
    }
}

private func isHotwordIntraWordPunctChar(_ ch: Character) -> Bool {
    switch ch {
    case ".", "-", "_", "'", "/", "+":
        return true
    default:
        return false
    }
}

private func isAsciiAlnumOrUnderscore(_ ch: Character) -> Bool {
    guard let s = ch.unicodeScalars.first, ch.unicodeScalars.count == 1 else { return false }
    return (s.value >= 0x30 && s.value <= 0x39)
        || (s.value >= 0x41 && s.value <= 0x5A)
        || (s.value >= 0x61 && s.value <= 0x7A)
        || s.value == 0x5F
}

private func normalizeHotwordMatchCharacters(_ raw: String) -> [Character] {
    let nfkc = raw.precomposedStringWithCompatibilityMapping.lowercased()
    var out: [Character] = []
    out.reserveCapacity(nfkc.count)
    for ch in nfkc {
        switch ch {
        case "\u{2010}", "\u{2011}", "\u{2012}", "\u{2013}", "\u{2014}", "\u{2015}", "\u{2212}", "\u{FE58}", "\u{FE63}":
            out.append("-")
        case "\u{2018}", "\u{2019}", "\u{201A}", "\u{201B}":
            out.append("'")
        case "\u{201C}", "\u{201D}", "\u{201E}", "\u{201F}":
            out.append("\"")
        case "\u{FF61}":
            out.append(".")
        default:
            out.append(ch)
        }
    }
    return out
}

private struct SwiftNormalizedClusterMap {
    let chars: [Character]
    let normToRawIndex: [String.Index]
    let clusterStart: [Int]
    let isSep: [Bool]
    let isSentenceEnd: [Bool]
    let isWeakTrailingSep: [Bool]
    let isIntraWordPunct: [Bool]
    let isAsciiAlnum: [Bool]
}

private func buildSwiftNormalizedClusterMap(_ text: String) -> SwiftNormalizedClusterMap {
    var chars: [Character] = []
    var normToRawIndex: [String.Index] = []
    var clusterStart: [Int] = []
    var isSep: [Bool] = []
    var isSentenceEnd: [Bool] = []
    var isWeakTrailingSep: [Bool] = []
    var isIntraWordPunct: [Bool] = []
    var isAsciiAlnum: [Bool] = []

    var rawIdx = text.startIndex
    while rawIdx < text.endIndex {
        let nextIdx = text.index(after: rawIdx)
        let normSlice = normalizeHotwordMatchCharacters(String(text[rawIdx..<nextIdx]))
        if !normSlice.isEmpty {
            let cStart = chars.count
            for ch in normSlice {
                chars.append(ch)
                normToRawIndex.append(rawIdx)
                clusterStart.append(cStart)
                isSep.append(isHotwordHallucinationSeparator(ch))
                isSentenceEnd.append(isHotwordSentenceEndChar(ch))
                isWeakTrailingSep.append(isHotwordWeakTrailingSepChar(ch))
                isIntraWordPunct.append(isHotwordIntraWordPunctChar(ch))
                isAsciiAlnum.append(isAsciiAlnumOrUnderscore(ch))
            }
        }
        rawIdx = nextIdx
    }
    normToRawIndex.append(text.endIndex)
    clusterStart.append(chars.count)

    return SwiftNormalizedClusterMap(
        chars: chars,
        normToRawIndex: normToRawIndex,
        clusterStart: clusterStart,
        isSep: isSep,
        isSentenceEnd: isSentenceEnd,
        isWeakTrailingSep: isWeakTrailingSep,
        isIntraWordPunct: isIntraWordPunct,
        isAsciiAlnum: isAsciiAlnum
    )
}

private final class HotwordTrieNode {
    var children: [Character: HotwordTrieNode] = [:]
    var termId: Int = -1
}

private struct SwiftDistinct3State {
    var t1: Int = -1
    var t2: Int = -1
    var count: Int = 0
}

private func advanceSwiftDistinct3(_ state: SwiftDistinct3State, termId: Int) -> SwiftDistinct3State {
    if state.count >= 3 { return state }
    if state.count == 0 { return SwiftDistinct3State(t1: termId, t2: -1, count: 1) }
    if state.count == 1 {
        return state.t1 == termId ? state : SwiftDistinct3State(t1: state.t1, t2: termId, count: 2)
    }
    if termId == state.t1 || termId == state.t2 { return state }
    return SwiftDistinct3State(t1: state.t1, t2: state.t2, count: 3)
}

private func hasValidSwiftLeadingSep(_ map: SwiftNormalizedClusterMap, pos: Int) -> Bool {
    guard map.isAsciiAlnum[pos] else { return true }
    var sepScan = pos
    while sepScan > 0 {
        let c = map.clusterStart[sepScan - 1]
        if !map.isSep[c] { break }
        for k in c..<sepScan where !map.isIntraWordPunct[k] {
            return true
        }
        sepScan = c
    }
    return false
}

private func isValidSwiftTrailingLeftBoundary(
    _ map: SwiftNormalizedClusterMap,
    p: Int,
    termStartsAscii: Bool
) -> (valid: Bool, sentEnd: Bool) {
    var sepScan = p
    var sentEnd = false
    var hasRealSep = false
    while sepScan > 0 {
        let c = map.clusterStart[sepScan - 1]
        if !map.isSep[c] { break }
        for k in c..<sepScan {
            if map.isSentenceEnd[k] { sentEnd = true }
            if !map.isIntraWordPunct[k] { hasRealSep = true }
        }
        sepScan = c
    }
    let hasSepBefore = sepScan < p
    let beforeSepAscii = sepScan > 0 ? map.isAsciiAlnum[sepScan - 1] : false
    let valid = hasSepBefore
        ? !(termStartsAscii && !hasRealSep && beforeSepAscii)
        : (termStartsAscii && !beforeSepAscii)
    return (valid, sentEnd)
}

private func findSwiftLeadingRuleACut(
    map: SwiftNormalizedClusterMap,
    root: HotwordTrieNode,
    termEndsAscii: [Bool]
) -> Int {
    let chars = map.chars
    let n = chars.count
    guard n > 0 else { return 0 }

    var completedSep = [Bool](repeating: false, count: n + 1)
    var sepRun = [[Int: Int]?](repeating: nil, count: n + 1)
    var immediateSame: [[Int: Int]?]? = nil
    completedSep[0] = true
    var bestCut = 0

    func recordRun(_ arr: inout [[Int: Int]?], _ pos: Int, _ tid: Int, _ len: Int) {
        var m = arr[pos] ?? [:]
        if len > (m[tid] ?? 0) {
            m[tid] = len
            arr[pos] = m
        }
    }

    for pos in 0..<n {
        let canStartFresh = completedSep[pos]
        let runMap = sepRun[pos]
        let immMap = immediateSame?[pos] ?? nil
        sepRun[pos] = nil
        immediateSame?[pos] = nil
        if !canStartFresh && runMap == nil && immMap == nil { continue }

        if pos > 0
            && pos == map.clusterStart[pos]
            && !map.isSep[pos]
            && canStartFresh
            && hasValidSwiftLeadingSep(map, pos: pos) {
            bestCut = pos
        }

        if map.isSep[pos] {
            let nextPos = pos + 1
            let isSentEnd = map.isSentenceEnd[pos]
            if canStartFresh {
                completedSep[nextPos] = true
            }
            if let runMap {
                for (tid, len) in runMap {
                    if len >= 2 { completedSep[nextPos] = true }
                    if !(len >= 2 && isSentEnd) {
                        recordRun(&sepRun, nextPos, tid, len)
                    }
                }
            }
            if let immMap {
                for (tid, len) in immMap {
                    if len >= 2 { completedSep[nextPos] = true }
                    if !(len >= 2 && isSentEnd) {
                        recordRun(&sepRun, nextPos, tid, len)
                    }
                }
            }
        }

        if pos != map.clusterStart[pos] { continue }

        var node: HotwordTrieNode? = root
        for p in pos..<n {
            node = node?.children[chars[p]]
            guard let cur = node else { break }
            let termId = cur.termId
            if termId < 0 { continue }

            let endPos = p + 1
            if endPos < n && endPos != map.clusterStart[endPos] { continue }

            var nextLen = canStartFresh ? 1 : 0
            if let prevRun = runMap?[termId], prevRun >= 1 {
                nextLen = max(nextLen, prevRun >= 2 ? 2 : prevRun + 1)
            }
            if let prevImm = immMap?[termId], prevImm >= 1 {
                nextLen = max(nextLen, prevImm >= 2 ? 2 : prevImm + 1)
            }
            if nextLen == 0 { continue }

            if !termEndsAscii[termId] || endPos == n {
                recordRun(&sepRun, endPos, termId, nextLen)
            } else {
                if immediateSame == nil {
                    immediateSame = [[Int: Int]?](repeating: nil, count: n + 1)
                }
                recordRun(&immediateSame!, endPos, termId, nextLen)
            }
        }
    }

    return bestCut
}

private func findSwiftLeadingRuleBCut(
    map: SwiftNormalizedClusterMap,
    root: HotwordTrieNode,
    termStartsAscii: [Bool],
    termEndsAscii: [Bool],
    termFirstChars: [Character]
) -> Int {
    let chars = map.chars
    let n = chars.count
    guard n > 0 else { return 0 }

    var clearedState = [SwiftDistinct3State?](repeating: nil, count: n + 1)
    var clearedFromSep = [Bool](repeating: false, count: n + 1)
    var clearedSepHasEnd = [Bool](repeating: false, count: n + 1)
    var endedAsciiState = [SwiftDistinct3State?](repeating: nil, count: n + 1)
    var sameState = [[Int: SwiftDistinct3State]?](repeating: nil, count: n + 1)

    clearedState[0] = SwiftDistinct3State()
    var bestCut = 0

    func pickBetter(_ a: SwiftDistinct3State?, _ b: SwiftDistinct3State) -> SwiftDistinct3State {
        guard let a else { return b }
        return b.count > a.count ? b : a
    }

    for pos in 0..<n {
        let cSt = clearedState[pos]
        let aSt = endedAsciiState[pos]
        let sMap = sameState[pos]
        sameState[pos] = nil
        if cSt == nil && aSt == nil && sMap == nil { continue }

        var bestOpt = cSt
        if let aSt { bestOpt = pickBetter(bestOpt, aSt) }
        if let sMap {
            for st in sMap.values { bestOpt = pickBetter(bestOpt, st) }
        }
        guard let bestSt = bestOpt else { continue }

        if pos > 0
            && pos == map.clusterStart[pos]
            && !map.isSep[pos]
            && clearedFromSep[pos]
            && clearedSepHasEnd[pos]
            && (cSt?.count ?? 0) >= 3
            && hasValidSwiftLeadingSep(map, pos: pos) {
            bestCut = pos
        }

        if map.isSep[pos] {
            let nextPos = pos + 1
            let propagatedFromCleared = cSt != nil && bestSt.count == cSt!.count
            let nextEnd = (propagatedFromCleared && clearedFromSep[pos] && clearedSepHasEnd[pos]) || map.isSentenceEnd[pos]
            if !(bestSt.count >= 3 && map.isSentenceEnd[pos] && clearedFromSep[pos] && clearedSepHasEnd[pos]) {
                let existing = clearedState[nextPos]
                if existing == nil || bestSt.count > existing!.count || (bestSt.count == existing!.count && nextEnd && !clearedSepHasEnd[nextPos]) {
                    clearedState[nextPos] = bestSt
                    clearedFromSep[nextPos] = true
                    clearedSepHasEnd[nextPos] = nextEnd
                }
            }
        }

        if pos != map.clusterStart[pos] { continue }
        if clearedFromSep[pos] && clearedSepHasEnd[pos] && (cSt?.count ?? 0) >= 3 {
            continue
        }

        var node: HotwordTrieNode? = root
        for p in pos..<n {
            node = node?.children[chars[p]]
            guard let cur = node else { break }
            let termId = cur.termId
            if termId < 0 { continue }

            let endPos = p + 1
            if endPos < n && endPos != map.clusterStart[endPos] { continue }

            var startSt = termStartsAscii[termId] ? cSt : bestSt
            if let sameEntry = sMap?[termId], (startSt == nil || sameEntry.count > startSt!.count) {
                startSt = sameEntry
            }
            guard let s = startSt else { continue }

            let nextSt = advanceSwiftDistinct3(s, termId: termId)
            if !termEndsAscii[termId] || endPos == n {
                clearedState[endPos] = pickBetter(clearedState[endPos], nextSt)
                clearedFromSep[endPos] = false
                clearedSepHasEnd[endPos] = false
            } else {
                endedAsciiState[endPos] = pickBetter(endedAsciiState[endPos], nextSt)
                if termStartsAscii[termId] && chars[endPos] == termFirstChars[termId] {
                    var targetMap = sameState[endPos] ?? [:]
                    targetMap[termId] = pickBetter(targetMap[termId], nextSt)
                    sameState[endPos] = targetMap
                }
            }
        }
    }

    return bestCut
}

private func findSwiftLeadingHallucinationCut(
    map: SwiftNormalizedClusterMap,
    root: HotwordTrieNode,
    termStartsAscii: [Bool],
    termEndsAscii: [Bool],
    termFirstChars: [Character]
) -> Int {
    return max(
        findSwiftLeadingRuleACut(map: map, root: root, termEndsAscii: termEndsAscii),
        findSwiftLeadingRuleBCut(
            map: map,
            root: root,
            termStartsAscii: termStartsAscii,
            termEndsAscii: termEndsAscii,
            termFirstChars: termFirstChars
        )
    )
}

private func findSwiftTrailingRuleACut(
    map: SwiftNormalizedClusterMap,
    revRoot: HotwordTrieNode,
    termStartsAscii: [Bool]
) -> Int {
    let chars = map.chars
    let n = chars.count
    guard n > 0 else { return n }

    var completedSep = [Bool](repeating: false, count: n + 1)
    var sepRun = [[Int: Int]?](repeating: nil, count: n + 1)
    var revSame: [[Int: Int]?]? = nil
    completedSep[n] = true
    var bestTermStart = n

    func recordRun(_ arr: inout [[Int: Int]?], _ pos: Int, _ tid: Int, _ len: Int) {
        var m = arr[pos] ?? [:]
        if len > (m[tid] ?? 0) {
            m[tid] = len
            arr[pos] = m
        }
    }

    for pos in stride(from: n, to: 0, by: -1) {
        if pos < n && pos != map.clusterStart[pos] { continue }
        let canEndFresh = completedSep[pos]
        let runMap = sepRun[pos]
        let immMap = revSame?[pos] ?? nil
        sepRun[pos] = nil
        revSame?[pos] = nil
        if !canEndFresh && runMap == nil && immMap == nil { continue }

        let prevClusterStart = map.clusterStart[pos - 1]
        if map.isSep[prevClusterStart] {
            var sepHasEnd = false
            for k in prevClusterStart..<pos where map.isSentenceEnd[k] {
                sepHasEnd = true
                break
            }
            if canEndFresh {
                completedSep[prevClusterStart] = true
            }
            if let runMap {
                for (tid, len) in runMap {
                    if len >= 2 { completedSep[prevClusterStart] = true }
                    if !(len >= 2 && sepHasEnd) {
                        recordRun(&sepRun, prevClusterStart, tid, len)
                    }
                }
            }
            if let immMap {
                for (tid, len) in immMap {
                    if len >= 2 { completedSep[prevClusterStart] = true }
                    if !(len >= 2 && sepHasEnd) {
                        recordRun(&sepRun, prevClusterStart, tid, len)
                    }
                }
            }
        }

        var revNode: HotwordTrieNode? = revRoot
        for p in stride(from: pos - 1, through: 0, by: -1) {
            revNode = revNode?.children[chars[p]]
            guard let cur = revNode else { break }
            let termId = cur.termId
            if termId < 0 { continue }
            if p != map.clusterStart[p] { continue }

            var nextLen = canEndFresh ? 1 : 0
            if let prevRun = runMap?[termId], prevRun >= 1 {
                nextLen = max(nextLen, prevRun >= 2 ? 2 : prevRun + 1)
            }
            if let prevImm = immMap?[termId], prevImm >= 1 {
                nextLen = max(nextLen, prevImm >= 2 ? 2 : prevImm + 1)
            }
            if nextLen == 0 { continue }

            if !termStartsAscii[termId] || p == 0 {
                recordRun(&sepRun, p, termId, nextLen)
            } else {
                if revSame == nil {
                    revSame = [[Int: Int]?](repeating: nil, count: n + 1)
                }
                recordRun(&revSame!, p, termId, nextLen)
            }

            if nextLen >= 2 && p > 0 {
                let (valid, _) = isValidSwiftTrailingLeftBoundary(map, p: p, termStartsAscii: termStartsAscii[termId])
                if valid && p < bestTermStart {
                    bestTermStart = p
                }
            }
        }
    }

    return bestTermStart
}

private func findSwiftTrailingRuleBCut(
    map: SwiftNormalizedClusterMap,
    revRoot: HotwordTrieNode,
    termStartsAscii: [Bool],
    termEndsAscii: [Bool],
    termLastChars: [Character]
) -> Int {
    let chars = map.chars
    let n = chars.count
    guard n > 0 else { return n }

    var revCleared = [SwiftDistinct3State?](repeating: nil, count: n + 1)
    var revClearedLocked = [Bool](repeating: false, count: n + 1)
    var revStartedAscii = [SwiftDistinct3State?](repeating: nil, count: n + 1)
    var revSame = [[Int: SwiftDistinct3State]?](repeating: nil, count: n + 1)

    revCleared[n] = SwiftDistinct3State()
    var bestTermStart = n

    func pickBetter(_ a: SwiftDistinct3State?, _ b: SwiftDistinct3State) -> SwiftDistinct3State {
        guard let a else { return b }
        return b.count > a.count ? b : a
    }

    for pos in stride(from: n, to: 0, by: -1) {
        if pos < n && pos != map.clusterStart[pos] { continue }
        let cSt = revCleared[pos]
        let aSt = revStartedAscii[pos]
        let sMap = revSame[pos]
        revSame[pos] = nil
        if cSt == nil && aSt == nil && sMap == nil { continue }

        var bestOpt = cSt
        if let aSt { bestOpt = pickBetter(bestOpt, aSt) }
        if let sMap {
            for st in sMap.values { bestOpt = pickBetter(bestOpt, st) }
        }
        guard let bestSt = bestOpt else { continue }

        let prevClusterStart = map.clusterStart[pos - 1]
        if map.isSep[prevClusterStart] {
            var sepHasEnd = false
            for k in prevClusterStart..<pos where map.isSentenceEnd[k] {
                sepHasEnd = true
                break
            }
            let crossedAfterValid = bestSt.count >= 3 && sepHasEnd
            if !(bestSt.count >= 3 && revClearedLocked[pos]) {
                let existing = revCleared[prevClusterStart]
                if existing == nil || bestSt.count > existing!.count {
                    revCleared[prevClusterStart] = bestSt
                    revClearedLocked[prevClusterStart] = revClearedLocked[pos] || crossedAfterValid
                }
            }
        }

        if revClearedLocked[pos] { continue }

        var revNode: HotwordTrieNode? = revRoot
        for p in stride(from: pos - 1, through: 0, by: -1) {
            revNode = revNode?.children[chars[p]]
            guard let cur = revNode else { break }
            let termId = cur.termId
            if termId < 0 { continue }
            if p != map.clusterStart[p] { continue }

            var rightSt = termEndsAscii[termId] ? cSt : bestSt
            if let sameEntry = sMap?[termId], (rightSt == nil || sameEntry.count > rightSt!.count) {
                rightSt = sameEntry
            }
            guard let r = rightSt else { continue }

            let nextSt = advanceSwiftDistinct3(r, termId: termId)
            if !termStartsAscii[termId] || p == 0 {
                revCleared[p] = pickBetter(revCleared[p], nextSt)
            } else {
                revStartedAscii[p] = pickBetter(revStartedAscii[p], nextSt)
                if termEndsAscii[termId] && p > 0 && chars[p - 1] == termLastChars[termId] {
                    var targetMap = revSame[p] ?? [:]
                    targetMap[termId] = pickBetter(targetMap[termId], nextSt)
                    revSame[p] = targetMap
                }
            }

            if nextSt.count >= 3 && p > 0 {
                let (valid, sentEnd) = isValidSwiftTrailingLeftBoundary(map, p: p, termStartsAscii: termStartsAscii[termId])
                if valid && sentEnd && p < bestTermStart {
                    bestTermStart = p
                }
            }
        }
    }

    return bestTermStart
}

private func findSwiftTrailingHallucinationCut(
    map: SwiftNormalizedClusterMap,
    revRoot: HotwordTrieNode,
    termStartsAscii: [Bool],
    termEndsAscii: [Bool],
    termLastChars: [Character]
) -> Int {
    let n = map.chars.count
    guard n > 0 else { return n }
    let startA = findSwiftTrailingRuleACut(map: map, revRoot: revRoot, termStartsAscii: termStartsAscii)
    let startB = findSwiftTrailingRuleBCut(
        map: map,
        revRoot: revRoot,
        termStartsAscii: termStartsAscii,
        termEndsAscii: termEndsAscii,
        termLastChars: termLastChars
    )
    let bestTermStart = min(startA, startB)
    guard bestTermStart < n else { return n }
    var cutNorm = bestTermStart
    while cutNorm > 0 {
        let c = map.clusterStart[cutNorm - 1]
        var allWeak = true
        for k in c..<cutNorm where !map.isWeakTrailingSep[k] {
            allWeak = false
            break
        }
        if !allWeak { break }
        cutNorm = c
    }
    return cutNorm
}

func stripVoiceHotwordHallucination(_ text: String, hotwordsContext: String?, allowSingle: Bool = false) -> String {
    guard !text.isEmpty, let hotwordsContext, !hotwordsContext.isEmpty else { return text }
    let splitTerms = hotwordsContext
        .split(whereSeparator: { $0 == "," || $0 == "\n" || $0 == "\r" })
        .map { String($0) }
    return stripVoiceHotwordHallucination(text, hotwordTerms: splitTerms, allowSingle: allowSingle)
}

func stripVoiceHotwordHallucination(_ text: String, hotwordTerms: [String], allowSingle: Bool = false) -> String {
    guard !text.isEmpty, !hotwordTerms.isEmpty else { return text }

    var seen = Set<[Character]>()
    var normalizedTerms: [[Character]] = []
    for raw in hotwordTerms {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { continue }
        let norm = normalizeHotwordMatchCharacters(trimmed)
        guard !norm.isEmpty, !seen.contains(norm) else { continue }
        seen.insert(norm)
        normalizedTerms.append(norm)
    }
    guard !normalizedTerms.isEmpty else { return text }

    let root = HotwordTrieNode()
    let revRoot = HotwordTrieNode()
    var termStartsAscii = [Bool](repeating: false, count: normalizedTerms.count)
    var termEndsAscii = [Bool](repeating: false, count: normalizedTerms.count)
    var termFirstChars = [Character](repeating: "\0", count: normalizedTerms.count)
    var termLastChars = [Character](repeating: "\0", count: normalizedTerms.count)
    for (termId, norm) in normalizedTerms.enumerated() {
        termStartsAscii[termId] = isAsciiAlnumOrUnderscore(norm[0])
        termEndsAscii[termId] = isAsciiAlnumOrUnderscore(norm[norm.count - 1])
        termFirstChars[termId] = norm[0]
        termLastChars[termId] = norm[norm.count - 1]

        var node = root
        for ch in norm {
            if let child = node.children[ch] {
                node = child
            } else {
                let child = HotwordTrieNode()
                node.children[ch] = child
                node = child
            }
        }
        node.termId = termId

        var revNode = revRoot
        for ch in norm.reversed() {
            if let child = revNode.children[ch] {
                revNode = child
            } else {
                let child = HotwordTrieNode()
                revNode.children[ch] = child
                revNode = child
            }
        }
        revNode.termId = termId
    }

    // Whole-string check normalizes the entire text via NFKC directly to preserve cross-codepoint Hangul/combining composition.
    let chars = normalizeHotwordMatchCharacters(text)
    let n = chars.count
    guard n > 0 else { return text }

    let inf = 0x3FFF_FFFF
    var cleared = [Int](repeating: inf, count: n + 1)
    var endedAscii = [Int](repeating: inf, count: n + 1)
    var sameTermStates: [[Int: Int]?]? = nil
    cleared[0] = 0

    for pos in 0..<n {
        let cCount = cleared[pos]
        let aCount = endedAscii[pos]
        let sameMap = sameTermStates?[pos] ?? nil
        sameTermStates?[pos] = nil
        if cCount == inf && aCount == inf && sameMap == nil { continue }
        let bestAtPos = min(cCount, aCount)

        if isHotwordHallucinationSeparator(chars[pos]) {
            var sepMin = bestAtPos
            if let sameMap {
                for cost in sameMap.values where cost < sepMin {
                    sepMin = cost
                }
            }
            if sepMin < cleared[pos + 1] {
                cleared[pos + 1] = sepMin
            }
        }

        var node: HotwordTrieNode? = root
        for p in pos..<n {
            node = node?.children[chars[p]]
            guard let cur = node else { break }
            let termId = cur.termId
            if termId < 0 { continue }

            var startCost = termStartsAscii[termId] ? cCount : bestAtPos
            if let sameCost = sameMap?[termId], sameCost < startCost {
                startCost = sameCost
            }
            if startCost >= inf { continue }

            let endPos = p + 1
            let nextCost = startCost + 1
            if !termEndsAscii[termId] || endPos == n {
                if nextCost < cleared[endPos] {
                    cleared[endPos] = nextCost
                }
            } else {
                if nextCost < endedAscii[endPos] {
                    endedAscii[endPos] = nextCost
                }
                if termStartsAscii[termId] && chars[endPos] == termFirstChars[termId] {
                    if sameTermStates == nil {
                        sameTermStates = [[Int: Int]?](repeating: nil, count: n + 1)
                    }
                    var targetMap = sameTermStates![endPos] ?? [:]
                    if let prev = targetMap[termId] {
                        if nextCost < prev { targetMap[termId] = nextCost }
                    } else {
                        targetMap[termId] = nextCost
                    }
                    sameTermStates![endPos] = targetMap
                }
            }
        }
    }

    let minMatches = min(cleared[n], endedAscii[n])
    if minMatches < inf {
        if minMatches >= 2 { return "" }
        if allowSingle && minMatches == 1 { return "" }
        return text
    }

    var current = text
    let wholeMap = buildSwiftNormalizedClusterMap(current)
    let leadCutNorm = findSwiftLeadingHallucinationCut(
        map: wholeMap,
        root: root,
        termStartsAscii: termStartsAscii,
        termEndsAscii: termEndsAscii,
        termFirstChars: termFirstChars
    )
    if leadCutNorm > 0 && leadCutNorm < wholeMap.chars.count {
        current = String(current[wholeMap.normToRawIndex[leadCutNorm]...])
    }
    guard !current.isEmpty else { return "" }

    let tailMap = leadCutNorm > 0 ? buildSwiftNormalizedClusterMap(current) : wholeMap
    let tailCutNorm = findSwiftTrailingHallucinationCut(
        map: tailMap,
        revRoot: revRoot,
        termStartsAscii: termStartsAscii,
        termEndsAscii: termEndsAscii,
        termLastChars: termLastChars
    )
    if tailCutNorm < tailMap.chars.count {
        current = String(current[..<tailMap.normToRawIndex[tailCutNorm]])
    }
    return current
}

struct QwenSegmentedDecodeResult {
    let text: String
    let tokens: [Int32]
}

final class QwenSegmentedDecodeEngine {
    typealias DecodeFn = (
        _ audio: [Float],
        _ prefixTokens: [Int32],
        _ checkCancellation: () throws -> Void
    ) throws -> QwenSegmentedDecodeResult?

    typealias RollbackPrefixFn = (
        _ tokens: [Int32],
        _ rollbackCount: Int,
        _ expectLanguageHeader: Bool
    ) -> [Int32]

    private let initialStrideSamples: Int
    private let strideSamples: Int
    private let maxSegmentSamples: Int
    private let maxFinalReDecodeSamples: Int
    private let rollbackTokenCount: Int
    private let expectLanguageHeader: Bool
    private let hotwordTerms: [String]
    private let decodeFn: DecodeFn
    private let rollbackPrefixFn: RollbackPrefixFn
    private let emitJsonFn: ([String: Any]) -> Void
    private let onLoopFinishedFn: () -> Void

    private let lock = NSLock()
    private let workSignal = DispatchSemaphore(value: 0)

    private var pendingSamples: [Float] = []
    private var activeSegment: [Float] = []
    private var utteranceSamples: [Float] = []
    private var utteranceExceededFinalCap = false
    private var lastDecodedCount = 0
    private var committedText = ""
    private var committedHasTrustedRealText = false
    private var activeText = ""
    private var activeTrustedRealText = ""
    private var activePendingSingleHotword = false
    private var retractedSegmentSingleHotword = false
    private var pendingRetractionFinal = false
    private var confirmedTokens: [Int32] = []
    private var activeSegmentTrimStart: Int? = nil
    private var lastEmittedText = ""
    private var stopRequested = false
    private var producerFinished = false
    private var aborted = false

    init(
        initialStrideSamples: Int = 12_800,
        strideSamples: Int = 16_000,
        maxSegmentSamples: Int = 216_000,
        maxFinalReDecodeSamples: Int = 480_000,
        rollbackTokenCount: Int = 5,
        expectLanguageHeader: Bool,
        hotwordTerms: [String] = [],
        decodeFn: @escaping DecodeFn,
        rollbackPrefixFn: @escaping RollbackPrefixFn,
        emitJsonFn: @escaping ([String: Any]) -> Void,
        onLoopFinishedFn: @escaping () -> Void = {}
    ) {
        self.initialStrideSamples = initialStrideSamples
        self.strideSamples = strideSamples
        self.maxSegmentSamples = maxSegmentSamples
        self.maxFinalReDecodeSamples = maxFinalReDecodeSamples
        self.rollbackTokenCount = rollbackTokenCount
        self.expectLanguageHeader = expectLanguageHeader
        self.hotwordTerms = hotwordTerms
        self.decodeFn = decodeFn
        self.rollbackPrefixFn = rollbackPrefixFn
        self.emitJsonFn = emitJsonFn
        self.onLoopFinishedFn = onLoopFinishedFn
    }

    private func appendUtteranceSamplesLocked(_ samples: [Float]) {
        guard !utteranceExceededFinalCap, !samples.isEmpty else { return }
        if utteranceSamples.count + samples.count > maxFinalReDecodeSamples {
            utteranceExceededFinalCap = true
            utteranceSamples.removeAll(keepingCapacity: false)
        } else {
            utteranceSamples.append(contentsOf: samples)
        }
    }

    func preload(_ initial: [Float]) {
        guard !initial.isEmpty else { return }
        lock.lock()
        let active = !producerFinished && !aborted
        if active {
            pendingSamples.append(contentsOf: initial)
            appendUtteranceSamplesLocked(initial)
        }
        lock.unlock()
        if active {
            workSignal.signal()
        }
    }

    @discardableResult
    func enqueue(_ samples: [Float]) -> Bool {
        guard !samples.isEmpty else { return false }
        lock.lock()
        let active = !producerFinished && !aborted
        if active {
            pendingSamples.append(contentsOf: samples)
            appendUtteranceSamplesLocked(samples)
        }
        let shouldWake = active && !pendingSamples.isEmpty
        lock.unlock()
        if shouldWake {
            workSignal.signal()
        }
        return active
    }

    func canAcceptCaptureSamples() -> Bool {
        lock.lock()
        let active = !producerFinished && !aborted
        lock.unlock()
        return active
    }

    func markProducerFinished() {
        lock.lock()
        producerFinished = true
        lock.unlock()
        workSignal.signal()
    }

    func requestStop(abort: Bool, producerAlsoFinished: Bool) {
        lock.lock()
        stopRequested = true
        if abort {
            aborted = true
            producerFinished = true
            utteranceSamples.removeAll(keepingCapacity: false)
        } else if producerAlsoFinished {
            producerFinished = true
        }
        lock.unlock()
        workSignal.signal()
    }

    private func isAbortedNow() -> Bool {
        lock.lock()
        let cancel = aborted
        lock.unlock()
        return cancel
    }

    @discardableResult
    private func emitJsonIfNotAborted(_ payload: [String: Any]) -> Bool {
        lock.lock()
        let cancel = aborted
        if !cancel {
            emitJsonFn(payload)
        }
        lock.unlock()
        return !cancel
    }

    func runLoop() {
        var skipNextWait = false
        while true {
            if !skipNextWait {
                _ = workSignal.wait(timeout: .now() + .milliseconds(250))
            }
            skipNextWait = false

            lock.lock()
            let isAborted = aborted
            let isStop = stopRequested
            let isProducerFinished = producerFinished
            if !pendingSamples.isEmpty {
                let remainingSpace = max(0, maxSegmentSamples - activeSegment.count)
                if pendingSamples.count > remainingSpace && remainingSpace > 0 {
                    activeSegment.append(contentsOf: pendingSamples.prefix(remainingSpace))
                    pendingSamples.removeFirst(remainingSpace)
                } else if remainingSpace > 0 {
                    activeSegment.append(contentsOf: pendingSamples)
                    pendingSamples.removeAll(keepingCapacity: true)
                }
            }
            let hasRemainingPending = !pendingSamples.isEmpty
            let currentLen = activeSegment.count
            let decodedCountSnapshot = lastDecodedCount
            let newCount = currentLen - decodedCountSnapshot
            let canReDecodeWholeUtterance = !utteranceExceededFinalCap && !utteranceSamples.isEmpty
            let exceededFinalCap = utteranceExceededFinalCap
            lock.unlock()

            if isAborted {
                break
            }

            let isFinalPass = isStop && isProducerFinished && !hasRemainingPending
            let isFinalWholeUtterance = isFinalPass && canReDecodeWholeUtterance
            let isFinalExceededSegment = isFinalPass && exceededFinalCap && currentLen > 0
            let shouldRunFinalDecode = isFinalWholeUtterance || isFinalExceededSegment

            if isFinalPass && !shouldRunFinalDecode && (!lastEmittedText.isEmpty || !committedText.isEmpty || pendingRetractionFinal || retractedSegmentSingleHotword) {
                let rawFinalCombined = !committedText.isEmpty && !activeText.isEmpty
                    ? joinTranscriptSegments(committedText, activeText)
                    : (!lastEmittedText.isEmpty ? lastEmittedText : committedText)
                let finalCombined = (!hotwordTerms.isEmpty
                    && (retractedSegmentSingleHotword || pendingRetractionFinal)
                    && !committedHasTrustedRealText
                    && activeTrustedRealText.isEmpty)
                    ? ""
                    : rawFinalCombined
                pendingRetractionFinal = false
                retractedSegmentSingleHotword = false
                _ = emitJsonIfNotAborted([
                    "type": "result",
                    "text": finalCombined,
                    "isFinal": true,
                ])
                break
            }

            let threshold = decodedCountSnapshot == 0 ? initialStrideSamples : strideSamples
            if shouldRunFinalDecode || newCount >= threshold || (currentLen >= maxSegmentSamples && hasRemainingPending) {
                let audioCopy: [Float]
                let prefixCopy: [Int32]
                lock.lock()
                if isFinalWholeUtterance {
                    audioCopy = utteranceSamples
                    utteranceSamples.removeAll(keepingCapacity: false)
                } else {
                    audioCopy = activeSegment
                }
                prefixCopy = isFinalPass ? [] : confirmedTokens
                lastDecodedCount = currentLen
                lock.unlock()

                let hasTrustedText = isFinalWholeUtterance
                    ? (committedHasTrustedRealText || !activeTrustedRealText.isEmpty || (hotwordTerms.isEmpty && (!committedText.isEmpty || !activeText.isEmpty)))
                    : (!activeTrustedRealText.isEmpty || (hotwordTerms.isEmpty && !activeText.isEmpty))

                let decodeAudio: [Float]
                if !isFinalPass && !prefixCopy.isEmpty {
                    let fixedStart = activeSegmentTrimStart ?? 0
                    decodeAudio = trimTrailingSilence(audioCopy, fixedStart: fixedStart)
                } else if let trimmed = trimSilenceEdgesWithRange(audioCopy) {
                    decodeAudio = trimmed.samples
                    if !isFinalPass {
                        activeSegmentTrimStart = trimmed.range.lowerBound
                    }
                } else {
                    decodeAudio = []
                    if !isFinalPass {
                        activeSegmentTrimStart = nil
                    }
                }

                if decodeAudio.isEmpty && (!hasTrustedText || isFinalPass) {
                    // Pure silence / faint noise floor: skip ASR decode so hotwords context cannot hallucinate.
                    if isFinalPass && (!lastEmittedText.isEmpty || !committedText.isEmpty || pendingRetractionFinal || activePendingSingleHotword) {
                        let finalCombined: String
                        if hotwordTerms.isEmpty {
                            finalCombined = !lastEmittedText.isEmpty ? lastEmittedText : committedText
                        } else if isFinalWholeUtterance {
                            finalCombined = committedHasTrustedRealText ? committedText : ""
                        } else {
                            finalCombined = (!lastEmittedText.isEmpty && !activePendingSingleHotword) ? lastEmittedText : committedText
                        }
                        pendingRetractionFinal = false
                        activePendingSingleHotword = false
                        lastEmittedText = finalCombined
                        _ = emitJsonIfNotAborted([
                            "type": "result",
                            "text": finalCombined,
                            "isFinal": true,
                        ])
                    }
                } else if !decodeAudio.isEmpty, let result = try? decodeFn(
                    decodeAudio,
                    prefixCopy,
                    { [weak self] in
                        guard let self else { throw CancellationError() }
                        if self.isAbortedNow() { throw CancellationError() }
                    }
                ) {
                    if isAbortedNow() {
                        break
                    }
                    let rawText = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    let hasHotwords = !hotwordTerms.isEmpty
                    if !hasHotwords {
                        let text = sanitizeAsrRepetitionLoop(rawText)
                        let hitRepetitionLoop = text != rawText
                        activeText = text
                        if hitRepetitionLoop {
                            confirmedTokens = []
                            activeSegmentTrimStart = nil
                        } else if !isFinalPass {
                            confirmedTokens = rollbackPrefixFn(
                                result.tokens,
                                rollbackTokenCount,
                                expectLanguageHeader
                            )
                        }
                        let baseCommitted = isFinalWholeUtterance ? "" : committedText
                        var combined = joinTranscriptSegments(baseCommitted, activeText)
                        if isFinalPass && combined.isEmpty && !lastEmittedText.isEmpty && !hitRepetitionLoop {
                            combined = lastEmittedText
                        }
                        if isFinalWholeUtterance && !combined.isEmpty {
                            committedText = ""
                        }
                        if !combined.isEmpty && (combined != lastEmittedText || isFinalPass) {
                            lastEmittedText = combined
                            if !emitJsonIfNotAborted([
                                "type": "result",
                                "text": combined,
                                "isFinal": isFinalPass,
                            ]) {
                                break
                            }
                        }
                    } else {
                        let preHallucination = stripVoiceHotwordHallucination(
                            rawText,
                            hotwordTerms: hotwordTerms,
                            allowSingle: false
                        )
                        let afterRepetition = sanitizeAsrRepetitionLoop(preHallucination)
                        let text = stripVoiceHotwordHallucination(
                            afterRepetition,
                            hotwordTerms: hotwordTerms,
                            allowSingle: false
                        )
                        let hitHotwordHallucination = !rawText.isEmpty && text.isEmpty && (preHallucination.isEmpty || !afterRepetition.isEmpty)
                        let hitAnyGuard = text != rawText
                        let hasRealNonHotword = !text.isEmpty && !stripVoiceHotwordHallucination(
                            text,
                            hotwordTerms: hotwordTerms,
                            allowSingle: true
                        ).isEmpty
                        let hadRetractedSingleHotword = pendingRetractionFinal || retractedSegmentSingleHotword
                        let blockedRetractedSingleHotword =
                            hadRetractedSingleHotword
                            && !hasRealNonHotword
                            && activeTrustedRealText.isEmpty
                            && (!isFinalWholeUtterance || !committedHasTrustedRealText)
                        let blockedTrustedOverwriteSingleHotword =
                            isFinalPass
                            && !text.isEmpty
                            && !hasRealNonHotword
                            && (isFinalWholeUtterance ? (committedHasTrustedRealText || !activeTrustedRealText.isEmpty) : !activeTrustedRealText.isEmpty)

                        if hitHotwordHallucination
                            || blockedRetractedSingleHotword
                            || blockedTrustedOverwriteSingleHotword
                            || (text.isEmpty && (activePendingSingleHotword || !activeTrustedRealText.isEmpty || (isFinalWholeUtterance && committedHasTrustedRealText))) {
                            confirmedTokens = []
                            activeSegmentTrimStart = nil
                            let trustedCommitted = (!isFinalWholeUtterance || committedHasTrustedRealText) ? committedText : ""
                            if !activeTrustedRealText.isEmpty {
                                activeText = activeTrustedRealText
                                let combined = joinTranscriptSegments(trustedCommitted, activeText)
                                if !combined.isEmpty && (combined != lastEmittedText || isFinalPass) {
                                    lastEmittedText = combined
                                    pendingRetractionFinal = false
                                    retractedSegmentSingleHotword = false
                                    if !emitJsonIfNotAborted([
                                        "type": "result",
                                        "text": combined,
                                        "isFinal": isFinalPass,
                                    ]) {
                                        break
                                    }
                                }
                            } else if !trustedCommitted.isEmpty {
                                activeText = ""
                                if activePendingSingleHotword {
                                    retractedSegmentSingleHotword = true
                                }
                                activePendingSingleHotword = false
                                if isFinalPass {
                                    retractedSegmentSingleHotword = false
                                }
                                if trustedCommitted != lastEmittedText || isFinalPass {
                                    lastEmittedText = trustedCommitted
                                    pendingRetractionFinal = false
                                    if !emitJsonIfNotAborted([
                                        "type": "result",
                                        "text": trustedCommitted,
                                        "isFinal": isFinalPass,
                                    ]) {
                                        break
                                    }
                                }
                            } else if activePendingSingleHotword || blockedRetractedSingleHotword || blockedTrustedOverwriteSingleHotword || (isFinalWholeUtterance && (!lastEmittedText.isEmpty || pendingRetractionFinal)) {
                                activeText = ""
                                if activePendingSingleHotword {
                                    retractedSegmentSingleHotword = true
                                }
                                activePendingSingleHotword = false
                                if isFinalPass {
                                    retractedSegmentSingleHotword = false
                                }
                                if !lastEmittedText.isEmpty || (isFinalPass && (pendingRetractionFinal || blockedRetractedSingleHotword)) {
                                    lastEmittedText = ""
                                    pendingRetractionFinal = !isFinalPass
                                    if !emitJsonIfNotAborted([
                                        "type": "result",
                                        "text": "",
                                        "isFinal": isFinalPass,
                                    ]) {
                                        break
                                    }
                                }
                            } else {
                                activeText = ""
                            }
                        } else {
                            activeText = text
                            if !text.isEmpty {
                                if hasRealNonHotword {
                                    activeTrustedRealText = text
                                    activePendingSingleHotword = false
                                    retractedSegmentSingleHotword = false
                                } else if activeTrustedRealText.isEmpty && !isFinalWholeUtterance {
                                    activePendingSingleHotword = true
                                }
                            }
                            if hitAnyGuard {
                                confirmedTokens = []
                                activeSegmentTrimStart = nil
                            } else if !isFinalPass {
                                confirmedTokens = rollbackPrefixFn(
                                    result.tokens,
                                    rollbackTokenCount,
                                    expectLanguageHeader
                                )
                            }
                            let baseCommitted = isFinalWholeUtterance ? "" : committedText
                            let rawCombined = joinTranscriptSegments(baseCommitted, activeText)
                            let combined = stripVoiceHotwordHallucination(
                                rawCombined,
                                hotwordTerms: hotwordTerms,
                                allowSingle: false
                            )
                            if !rawCombined.isEmpty && combined.isEmpty {
                                // Cross-segment concatenation formed a pure repeated-hotword hallucination:
                                // retract instead of emitting "IM.codes IM.codes".
                                activeText = ""
                                activePendingSingleHotword = false
                                confirmedTokens = []
                                activeSegmentTrimStart = nil
                                if !committedHasTrustedRealText {
                                    committedText = ""
                                }
                                retractedSegmentSingleHotword = true
                                if !lastEmittedText.isEmpty || isFinalPass {
                                    lastEmittedText = ""
                                    pendingRetractionFinal = !isFinalPass
                                    if !emitJsonIfNotAborted([
                                        "type": "result",
                                        "text": "",
                                        "isFinal": isFinalPass,
                                    ]) {
                                        break
                                    }
                                }
                            } else {
                                if isFinalWholeUtterance && !combined.isEmpty {
                                    committedText = ""
                                }
                                if !combined.isEmpty && (combined != lastEmittedText || isFinalPass) {
                                    lastEmittedText = combined
                                    pendingRetractionFinal = false
                                    if isFinalPass && hasRealNonHotword {
                                        retractedSegmentSingleHotword = false
                                    }
                                    if !emitJsonIfNotAborted([
                                        "type": "result",
                                        "text": combined,
                                        "isFinal": isFinalPass,
                                    ]) {
                                        break
                                    }
                                }
                            }
                        }
                    }
                } else {
                    if isAbortedNow() {
                        break
                    }
                    if isFinalPass && (!lastEmittedText.isEmpty || !committedText.isEmpty || pendingRetractionFinal) {
                        let rawFinal = !lastEmittedText.isEmpty ? lastEmittedText : committedText
                        let sanitizedFinal = hotwordTerms.isEmpty
                            ? rawFinal
                            : stripVoiceHotwordHallucination(rawFinal, hotwordTerms: hotwordTerms, allowSingle: false)
                        let finalCombined = (retractedSegmentSingleHotword && !committedHasTrustedRealText && !sanitizedFinal.isEmpty && stripVoiceHotwordHallucination(sanitizedFinal, hotwordTerms: hotwordTerms, allowSingle: true).isEmpty)
                            ? ""
                            : sanitizedFinal
                        pendingRetractionFinal = false
                        _ = emitJsonIfNotAborted([
                            "type": "result",
                            "text": finalCombined,
                            "isFinal": true,
                        ])
                    }
                }

                if !isFinalPass && currentLen >= maxSegmentSamples {
                    let nextCommitted = hotwordTerms.isEmpty
                        ? joinTranscriptSegments(committedText, activeText)
                        : stripVoiceHotwordHallucination(
                            joinTranscriptSegments(committedText, activeText),
                            hotwordTerms: hotwordTerms,
                            allowSingle: false
                        )
                    if !activeTrustedRealText.isEmpty || (hotwordTerms.isEmpty && !activeText.isEmpty) {
                        committedHasTrustedRealText = true
                    } else if nextCommitted.isEmpty && !committedHasTrustedRealText {
                        committedHasTrustedRealText = false
                    }
                    committedText = nextCommitted
                    activeText = ""
                    activeTrustedRealText = ""
                    activePendingSingleHotword = false
                    confirmedTokens = []
                    activeSegmentTrimStart = nil
                    lock.lock()
                    activeSegment.removeAll(keepingCapacity: true)
                    lastDecodedCount = 0
                    lock.unlock()
                }
            }

            if isFinalPass {
                break
            }
            if hasRemainingPending || (isStop && isProducerFinished) {
                skipNextWait = true
            }
        }

        onLoopFinishedFn()
    }
}

// MARK: - End Segmented Decode Engine

final class QwenStreamingSession {
    private let sampleRate = 16_000
    private let maxSegmentSamples = 216_000 // 13.5s bounded segment
    private let maxFinalReDecodeSamples = 480_000 // 30s full-utterance final re-decode cap
    private let rollbackTokenCount = 5

    private let model: Qwen3ASRModel
    private let hotwordsContext: String?
    private let hotwordTerms: [String]
    private let decodeQueue: DispatchQueue
    private let unloadOnFinish: Bool
    private let captureQueue = DispatchQueue(label: "com.imcodes.pc-app.qwen3asr.capture", qos: .userInteractive)
    private var captureSession: AVCaptureSession?
    private var captureOutput: AVCaptureAudioDataOutput?
    private var captureDelegate: CaptureAudioDelegate?
    private var captureRuntimeObserver: NSObjectProtocol?
    private var fallbackConverter: AVAudioConverter?
    private var fallbackInputSignature: String?
    private var pcmMode = false
    private let lock = NSLock()
    private let doneSemaphore = DispatchSemaphore(value: 0)

    private var lastLevelEmit = Date.distantPast
    private var stopRequested = false
    private var aborted = false
    private var finished = false
    private var onFinishCallback: (() -> Void)?
    private var decodeEngine: QwenSegmentedDecodeEngine?

    init(
        model: Qwen3ASRModel,
        hotwordsContext: String?,
        hotwordTerms: [String],
        decodeQueue: DispatchQueue,
        unloadOnFinish: Bool
    ) {
        self.model = model
        self.hotwordsContext = hotwordsContext
        self.hotwordTerms = hotwordTerms
        self.decodeQueue = decodeQueue
        self.unloadOnFinish = unloadOnFinish
    }

    private func makeDecodeEngine(language: String?) -> QwenSegmentedDecodeEngine {
        let model = self.model
        let hotwordsContext = self.hotwordsContext
        let hotwordTerms = self.hotwordTerms
        let sampleRate = self.sampleRate
        let rollbackTokenCount = self.rollbackTokenCount
        let maxSegmentSamples = self.maxSegmentSamples
        let maxFinalReDecodeSamples = self.maxFinalReDecodeSamples
        return QwenSegmentedDecodeEngine(
            maxSegmentSamples: maxSegmentSamples,
            maxFinalReDecodeSamples: maxFinalReDecodeSamples,
            rollbackTokenCount: rollbackTokenCount,
            expectLanguageHeader: language == nil,
            hotwordTerms: hotwordTerms,
            decodeFn: { samples, prefixTokens, checkCancellation in
                let options = Qwen3DecodingOptions(
                    maxTokens: samples.count > maxSegmentSamples ? 384 : 192,
                    language: language,
                    context: hotwordsContext
                )
                let result = try model.transcribeSegmentWithCancellation(
                    audio: samples,
                    sampleRate: sampleRate,
                    options: options,
                    prefixTokens: prefixTokens,
                    checkCancellation: checkCancellation
                )
                return QwenSegmentedDecodeResult(text: result.text, tokens: result.tokens)
            },
            rollbackPrefixFn: { tokens, rollbackCount, expectLangHeader in
                model.safePrefixTokensForRollback(
                    tokens,
                    rollbackCount: rollbackCount,
                    expectLanguageHeader: expectLangHeader
                )
            },
            emitJsonFn: { payload in
                emitJson(payload)
            }
        )
    }

    private func failStart(code: String, message: String? = nil, emitEndOnStartFailure: Bool) {
        var payload: [String: Any] = ["type": "error", "code": code]
        if let message {
            payload["message"] = message
        }
        emitJson(payload)
        if emitEndOnStartFailure {
            finish()
        } else {
            onFinishCallback?()
            doneSemaphore.signal()
        }
    }

    func start(
        localeTag: String?,
        deviceUID: String?,
        emitEndOnStartFailure: Bool,
        initialSamples: [Float] = [],
        onFinish: (() -> Void)? = nil
    ) -> Bool {
        onFinishCallback = onFinish
        let language = Qwen3ASRModel.resolveLanguage(localeTag)
        let engine = makeDecodeEngine(language: language)
        lock.lock()
        decodeEngine = engine
        lock.unlock()
        engine.preload(initialSamples)

        let clamshellClosed = isMacBookClamshellClosed()
        guard let captureDevice = resolveCaptureDevice(deviceUID: deviceUID, clamshellClosed: clamshellClosed) else {
            failStart(code: "no_audio_input", emitEndOnStartFailure: emitEndOnStartFailure)
            return false
        }
        fputs("[imcodes-speech-mlx] capture device name=\"\(captureDevice.localizedName)\" uid=\"\(captureDevice.uniqueID)\" requested=\"\(deviceUID ?? "auto")\" clamshellClosed=\(clamshellClosed)\n", stderr)

        let session = AVCaptureSession()
        let deviceInput: AVCaptureDeviceInput
        do {
            deviceInput = try AVCaptureDeviceInput(device: captureDevice)
        } catch {
            fputs("[imcodes-speech-mlx] AVCaptureDeviceInput failed: \(error.localizedDescription)\n", stderr)
            failStart(
                code: "audio_engine_failed",
                message: error.localizedDescription,
                emitEndOnStartFailure: emitEndOnStartFailure
            )
            return false
        }

        let audioOutput = AVCaptureAudioDataOutput()
        audioOutput.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: Double(sampleRate),
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: true,
            AVLinearPCMIsBigEndianKey: false,
        ]

        let delegate = CaptureAudioDelegate { [weak self] sampleBuffer in
            self?.appendCaptureSampleBuffer(sampleBuffer)
        }
        audioOutput.setSampleBufferDelegate(delegate, queue: captureQueue)

        session.beginConfiguration()
        guard session.canAddInput(deviceInput), session.canAddOutput(audioOutput) else {
            session.commitConfiguration()
            audioOutput.setSampleBufferDelegate(nil, queue: nil)
            failStart(code: "no_audio_input", emitEndOnStartFailure: emitEndOnStartFailure)
            return false
        }
        session.addInput(deviceInput)
        session.addOutput(audioOutput)
        session.commitConfiguration()

        let observer = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification,
            object: session,
            queue: nil
        ) { [weak self] notification in
            let err = notification.userInfo?[AVCaptureSessionErrorKey] as? NSError
            let msg = err?.localizedDescription ?? "AVCaptureSession runtime error"
            fputs("[imcodes-speech-mlx] AVCaptureSession runtime error: \(msg)\n", stderr)
            self?.handleCaptureRuntimeError(message: msg)
        }

        lock.lock()
        captureSession = session
        captureOutput = audioOutput
        captureDelegate = delegate
        captureRuntimeObserver = observer
        lock.unlock()

        session.startRunning()
        guard session.isRunning else {
            teardownCaptureSession()
            failStart(
                code: "audio_engine_failed",
                message: "Audio capture session failed to start",
                emitEndOnStartFailure: emitEndOnStartFailure
            )
            return false
        }

        emitJson(["type": "start"])

        decodeQueue.async { [weak self] in
            self?.workerLoop()
        }
        return true
    }

    private func handleCaptureRuntimeError(message: String) {
        lock.lock()
        let alreadyEnding = stopRequested || aborted || finished
        lock.unlock()
        if alreadyEnding { return }
        emitJson([
            "type": "error",
            "code": "audio_engine_failed",
            "message": message,
        ])
        stop(abort: true)
    }

    private func teardownCaptureSession() {
        lock.lock()
        let session = captureSession
        let output = captureOutput
        let observer = captureRuntimeObserver
        captureSession = nil
        captureOutput = nil
        captureDelegate = nil
        captureRuntimeObserver = nil
        fallbackConverter = nil
        fallbackInputSignature = nil
        lock.unlock()

        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        output?.setSampleBufferDelegate(nil, queue: nil)
        if let session {
            if session.isRunning {
                session.stopRunning()
            }
            session.beginConfiguration()
            for input in session.inputs {
                session.removeInput(input)
            }
            for existingOutput in session.outputs {
                session.removeOutput(existingOutput)
            }
            session.commitConfiguration()
        }
    }

    func startPcm(
        localeTag: String?,
        onFinish: (() -> Void)? = nil
    ) -> Bool {
        pcmMode = true
        onFinishCallback = onFinish
        let language = Qwen3ASRModel.resolveLanguage(localeTag)

        if !pcmMode {
            teardownCaptureSession()
        }
        let engine = makeDecodeEngine(language: language)
        lock.lock()
        decodeEngine = engine
        lock.unlock()
        emitJson(["type": "start"])

        decodeQueue.async { [weak self] in
            self?.workerLoop()
        }
        return true
    }

    static func decodePcm16Base64(_ base64Data: String) -> [Float] {
        guard let raw = Data(base64Encoded: base64Data, options: [.ignoreUnknownCharacters]),
              raw.count >= 2 else {
            return []
        }
        let sampleCount = raw.count / 2
        var samples = [Float](repeating: 0, count: sampleCount)
        raw.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress else { return }
            let bytes = base.assumingMemoryBound(to: UInt8.self)
            for i in 0..<sampleCount {
                let lo = UInt16(bytes[i * 2])
                let hi = UInt16(bytes[i * 2 + 1])
                let signed = Int16(bitPattern: lo | (hi << 8))
                samples[i] = Float(signed) / 32768.0
            }
        }
        return samples
    }

    func pushPcm(base64Data: String) {
        let samples = Self.decodePcm16Base64(base64Data)
        guard !samples.isEmpty else { return }
        lock.lock()
        let engine = decodeEngine
        lock.unlock()
        _ = engine?.enqueue(samples)
    }

    func waitForCompletion() {
        _ = doneSemaphore.wait(timeout: .distantFuture)
    }

    private func enqueueCapturedSamples(_ samples: [Float]) {
        let frameCount = samples.count
        guard frameCount > 0 else { return }
        var sumSquares: Float = 0
        for s in samples {
            sumSquares += s * s
        }

        let now = Date()
        lock.lock()
        let engine = decodeEngine
        let shouldEmitLevel = !stopRequested && !aborted && now.timeIntervalSince(lastLevelEmit) >= 0.09
        if shouldEmitLevel {
            lastLevelEmit = now
        }
        lock.unlock()

        _ = engine?.enqueue(samples)
        if shouldEmitLevel {
            let rms = sqrt(sumSquares / Float(frameCount))
            emitJson(["type": "level", "value": min(1.0, Double(rms * 4.0))])
        }
    }

    private func appendCaptureSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer),
              let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else {
            return
        }
        let asbd = asbdPtr.pointee
        var neededSize = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &neededSize,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: nil
        )
        guard neededSize >= MemoryLayout<AudioBufferList>.size else { return }

        let rawABL = UnsafeMutableRawPointer.allocate(
            byteCount: neededSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { rawABL.deallocate() }
        let ablPtr = rawABL.assumingMemoryBound(to: AudioBufferList.self)
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: ablPtr,
            bufferListSize: neededSize,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }

        let isFloat32 = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0 && asbd.mBitsPerChannel == 32
        let isBigEndian = (asbd.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0
        if isFloat32 && !isBigEndian && asbd.mChannelsPerFrame == 1 && abs(asbd.mSampleRate - Double(sampleRate)) < 1.0 {
            let buffer = ablPtr.pointee.mBuffers
            let sampleCount = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            guard sampleCount > 0, let rawData = buffer.mData else { return }
            let floatPtr = rawData.assumingMemoryBound(to: Float.self)
            let samples = Array(UnsafeBufferPointer(start: floatPtr, count: sampleCount))
            enqueueCapturedSamples(samples)
            return
        }

        let inputFormat = AVAudioFormat(cmAudioFormatDescription: formatDesc)
        let numFrames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard numFrames > 0, let pcmBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: numFrames) else {
            return
        }
        pcmBuffer.frameLength = numFrames
        let srcList = UnsafeMutableAudioBufferListPointer(ablPtr)
        let dstList = UnsafeMutableAudioBufferListPointer(pcmBuffer.mutableAudioBufferList)
        for idx in 0..<min(srcList.count, dstList.count) {
            if let src = srcList[idx].mData, let dst = dstList[idx].mData {
                let copyBytes = min(Int(srcList[idx].mDataByteSize), Int(dstList[idx].mDataByteSize))
                if copyBytes > 0 {
                    memcpy(dst, src, copyBytes)
                    dstList[idx].mDataByteSize = UInt32(copyBytes)
                }
            }
        }

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(sampleRate),
            channels: 1,
            interleaved: false
        ) else {
            return
        }
        let sig = "\(asbd.mSampleRate)-\(asbd.mChannelsPerFrame)-\(asbd.mFormatFlags)-\(asbd.mBitsPerChannel)"
        let converter: AVAudioConverter
        if fallbackInputSignature == sig, let existing = fallbackConverter {
            converter = existing
        } else if let created = AVAudioConverter(from: inputFormat, to: targetFormat) {
            fallbackInputSignature = sig
            fallbackConverter = created
            converter = created
        } else {
            return
        }
        appendAudioBuffer(pcmBuffer, converter: converter, targetFormat: targetFormat)
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

        let samples = Array(UnsafeBufferPointer(start: channelData, count: frameCount))
        enqueueCapturedSamples(samples)
    }

    private func workerLoop() {
        lock.lock()
        let engine = decodeEngine
        lock.unlock()
        engine?.runLoop()

        if unloadOnFinish {
            model.unload()
            Qwen3ASRModel.clearMetalCache()
        }
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
        let engine = decodeEngine
        lock.unlock()

        engine?.requestStop(abort: abort, producerAlsoFinished: abort || pcmMode)
        if !pcmMode {
            teardownCaptureSession()
            if !abort {
                captureQueue.sync {}
            }
        }
        engine?.markProducerFinished()
    }

    private func finish() {
        lock.lock()
        if finished {
            lock.unlock()
            return
        }
        finished = true
        lock.unlock()

        if !pcmMode {
            teardownCaptureSession()
        }
        emitJson(["type": "end"])
        let cb = onFinishCallback
        onFinishCallback = nil
        cb?()
        doneSemaphore.signal()
    }
}

final class QwenServeRunner {
    private let model: Qwen3ASRModel
    private let hotwords: [String]
    private let decodeQueue: DispatchQueue
    private let sessionLock = NSLock()
    private var activeSession: QwenStreamingSession?
    private var prefilledPcm: [Float] = []
    private let maxPrefillSamples = 16_000 * 30
    private var shuttingDown = false

    init(model: Qwen3ASRModel, hotwords: [String], decodeQueue: DispatchQueue) {
        self.model = model
        self.hotwords = hotwords
        self.decodeQueue = decodeQueue
    }

    private func stopActiveSession(abort: Bool, wait: Bool) {
        sessionLock.lock()
        let current = activeSession
        sessionLock.unlock()
        guard let current else { return }
        current.stop(abort: abort)
        if wait {
            current.waitForCompletion()
        }
    }

    func shutdown() -> Never {
        sessionLock.lock()
        if shuttingDown {
            sessionLock.unlock()
            exit(0)
        }
        shuttingDown = true
        let current = activeSession
        sessionLock.unlock()

        if let current {
            current.stop(abort: true)
            current.waitForCompletion()
        }
        decodeQueue.sync {
            model.unload()
            Qwen3ASRModel.clearMetalCache()
        }
        exit(0)
    }

    func run() -> Never {
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                  let json = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
                  let cmd = json["cmd"] as? String else {
                continue
            }

            switch cmd {
            case "prefill_reset":
                prefilledPcm.removeAll(keepingCapacity: false)
            case "prefill_pcm":
                if let b64 = json["data"] as? String {
                    let samples = QwenStreamingSession.decodePcm16Base64(b64)
                    if !samples.isEmpty {
                        prefilledPcm.append(contentsOf: samples)
                        if prefilledPcm.count > maxPrefillSamples {
                            prefilledPcm.removeFirst(prefilledPcm.count - maxPrefillSamples)
                        }
                    }
                }
            case "start":
                stopActiveSession(abort: true, wait: true)
                let initialSamples = prefilledPcm
                prefilledPcm.removeAll(keepingCapacity: false)
                let micStatus = requestMicIfNeeded()
                guard micStatus == .authorized else {
                    emitJson(["type": "error", "code": "permission_denied", "target": "mic"])
                    emitJson(["type": "end"])
                    continue
                }
                let localeTag = json["locale"] as? String
                let deviceUID = json["device"] as? String
                let mergedHotwords = mergeSessionHotwords(base: hotwords, requestHotwords: json["hotwords"])
                let session = QwenStreamingSession(
                    model: model,
                    hotwordsContext: mergedHotwords.context,
                    hotwordTerms: mergedHotwords.filterTerms,
                    decodeQueue: decodeQueue,
                    unloadOnFinish: false
                )
                sessionLock.lock()
                if shuttingDown {
                    sessionLock.unlock()
                    shutdown()
                }
                activeSession = session
                sessionLock.unlock()
                _ = session.start(
                    localeTag: localeTag,
                    deviceUID: deviceUID,
                    emitEndOnStartFailure: true,
                    initialSamples: initialSamples,
                    onFinish: { [weak self, weak session] in
                        guard let self, let session else { return }
                        self.sessionLock.lock()
                        if self.activeSession === session {
                            self.activeSession = nil
                        }
                        self.sessionLock.unlock()
                    }
                )
            case "start_pcm":
                prefilledPcm.removeAll(keepingCapacity: false)
                stopActiveSession(abort: true, wait: true)
                let localeTag = json["locale"] as? String
                let mergedHotwords = mergeSessionHotwords(base: hotwords, requestHotwords: json["hotwords"])
                let session = QwenStreamingSession(
                    model: model,
                    hotwordsContext: mergedHotwords.context,
                    hotwordTerms: mergedHotwords.filterTerms,
                    decodeQueue: decodeQueue,
                    unloadOnFinish: false
                )
                sessionLock.lock()
                if shuttingDown {
                    sessionLock.unlock()
                    shutdown()
                }
                activeSession = session
                sessionLock.unlock()
                _ = session.startPcm(
                    localeTag: localeTag,
                    onFinish: { [weak self, weak session] in
                        guard let self, let session else { return }
                        self.sessionLock.lock()
                        if self.activeSession === session {
                            self.activeSession = nil
                        }
                        self.sessionLock.unlock()
                    }
                )
            case "pcm":
                sessionLock.lock()
                let current = activeSession
                sessionLock.unlock()
                if let b64 = json["data"] as? String {
                    current?.pushPcm(base64Data: b64)
                }
            case "stop":
                stopActiveSession(abort: false, wait: false)
            case "abort":
                prefilledPcm.removeAll(keepingCapacity: false)
                stopActiveSession(abort: true, wait: false)
            case "shutdown":
                prefilledPcm.removeAll(keepingCapacity: false)
                shutdown()
            default:
                continue
            }
        }
        shutdown()
    }
}

private func parseModelArgs(_ args: [String]) -> (modelDirPath: String?, variant: String, localeTag: String?, deviceUID: String?) {
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
    return (modelDirPath, variant, localeTag, deviceUID)
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
    let parsed = parseModelArgs(args)
    guard let modelDirPath = parsed.modelDirPath, !modelDirPath.isEmpty else {
        emitJson(["type": "error", "code": "missing_model_dir"])
        exit(2)
    }
    guard checkMlxRuntimeAvailable() else {
        exit(1)
    }
    guard requestMicIfNeeded() == .authorized else {
        emitJson(["type": "error", "code": "permission_denied", "target": "mic"])
        exit(1)
    }
    let modelDir = URL(fileURLWithPath: modelDirPath, isDirectory: true)
    let decodeQueue = DispatchQueue(label: "com.imcodes.pc-app.qwen3asr", qos: .userInteractive)
    guard let model = loadMlxModel(modelDir: modelDir, variant: parsed.variant, onQueue: decodeQueue) else {
        exit(1)
    }
    let staticHotwords = readHotwords(from: modelDir)
    let session = QwenStreamingSession(
        model: model,
        hotwordsContext: staticHotwords.isEmpty ? nil : staticHotwords.joined(separator: ", "),
        hotwordTerms: staticHotwords,
        decodeQueue: decodeQueue,
        unloadOnFinish: true
    )
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termSrc.setEventHandler { session.stop(abort: true) }
    termSrc.resume()
    let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    intSrc.setEventHandler { session.stop(abort: true) }
    intSrc.resume()
    guard session.start(localeTag: parsed.localeTag, deviceUID: parsed.deviceUID, emitEndOnStartFailure: false) else {
        model.unload()
        Qwen3ASRModel.clearMetalCache()
        exit(1)
    }
    DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine(strippingNewline: true) {
            if line == "stop" || line == "abort" {
                session.stop(abort: line == "abort")
                return
            }
        }
        session.stop(abort: false)
    }
    session.waitForCompletion()
    exit(0)
case "serve":
    let parsed = parseModelArgs(args)
    guard let modelDirPath = parsed.modelDirPath, !modelDirPath.isEmpty else {
        emitJson(["type": "error", "code": "missing_model_dir"])
        exit(2)
    }
    guard checkMlxRuntimeAvailable() else {
        exit(1)
    }
    let modelDir = URL(fileURLWithPath: modelDirPath, isDirectory: true)
    let decodeQueue = DispatchQueue(label: "com.imcodes.pc-app.qwen3asr", qos: .userInteractive)
    guard let model = loadMlxModel(modelDir: modelDir, variant: parsed.variant, onQueue: decodeQueue) else {
        exit(1)
    }
    emitJson(["type": "ready", "variant": parsed.variant])
    let runner = QwenServeRunner(
        model: model,
        hotwords: readHotwords(from: modelDir),
        decodeQueue: decodeQueue
    )
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termSrc.setEventHandler { runner.shutdown() }
    termSrc.resume()
    let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    intSrc.setEventHandler { runner.shutdown() }
    intSrc.resume()
    runner.run()
default:
    emitJson(["type": "error", "code": "unknown_command", "command": cmd])
    exit(2)
}
