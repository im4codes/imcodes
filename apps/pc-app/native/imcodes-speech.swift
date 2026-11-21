import ApplicationServices
import AudioToolbox
import AVFoundation
import Cocoa
import CoreAudio
import CoreGraphics
import Foundation
import Speech

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

func mapMicStatus(_ status: AVAuthorizationStatus) -> String {
  switch status {
  case .authorized:
    return "authorized"
  case .denied:
    return "denied"
  case .restricted:
    return "restricted"
  case .notDetermined:
    return "not-determined"
  @unknown default:
    return "denied"
  }
}

func mapSpeechStatus(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch status {
  case .authorized:
    return "authorized"
  case .denied:
    return "denied"
  case .restricted:
    return "restricted"
  case .notDetermined:
    return "not-determined"
  @unknown default:
    return "denied"
  }
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

func requestSpeechIfNeeded() -> SFSpeechRecognizerAuthorizationStatus {
  let current = SFSpeechRecognizer.authorizationStatus()
  if current != .notDetermined {
    return current
  }
  let sem = DispatchSemaphore(value: 0)
  var latest = current
  SFSpeechRecognizer.requestAuthorization { status in
    latest = status
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + .seconds(30))
  return latest
}

func currentStatusPayload() -> [String: Any] {
  let mic = mapMicStatus(AVCaptureDevice.authorizationStatus(for: .audio))
  let speech = mapSpeechStatus(SFSpeechRecognizer.authorizationStatus())
  let available = SFSpeechRecognizer()?.isAvailable ?? false
  return [
    "mic": mic,
    "speech": speech,
    "speechAvailable": available,
  ]
}

private func resolveSupportedRecognizer(for rawTag: String, supported: Set<Locale>) -> SFSpeechRecognizer? {
  let normalized = rawTag.trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: "_", with: "-")
  guard !normalized.isEmpty else { return nil }

  func makeMatched(_ identifier: String) -> SFSpeechRecognizer? {
    let targetLower = identifier.replacingOccurrences(of: "_", with: "-").lowercased()
    if !supported.isEmpty {
      if let exact = supported.first(where: {
        $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == targetLower
      }) {
        return SFSpeechRecognizer(locale: exact)
      }
      return nil
    }
    return SFSpeechRecognizer(locale: Locale(identifier: identifier))
  }

  if let exact = makeMatched(normalized) {
    return exact
  }

  let lower = normalized.lowercased()
  if lower == "zh-hans" || lower.hasPrefix("zh-hans-") {
    for candidate in ["zh-CN", "zh-SG"] {
      if let r = makeMatched(candidate) { return r }
    }
  } else if lower == "zh-hant" || lower.hasPrefix("zh-hant-") {
    for candidate in ["zh-TW", "zh-HK", "zh-MO"] {
      if let r = makeMatched(candidate) { return r }
    }
  }

  let baseLang = lower.split(separator: "-", maxSplits: 1).first.map(String.init) ?? lower
  if !supported.isEmpty {
    if baseLang == "zh" {
      for candidate in ["zh-CN", "zh-TW", "zh-HK"] {
        if let r = makeMatched(candidate) { return r }
      }
    }
    let prefix = baseLang + "-"
    if let prefixed = supported
      .sorted(by: { $0.identifier < $1.identifier })
      .first(where: {
        let idLower = $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased()
        return idLower == baseLang || idLower.hasPrefix(prefix)
      }) {
      return SFSpeechRecognizer(locale: prefixed)
    }
  }

  return SFSpeechRecognizer(locale: Locale(identifier: normalized))
}

func resolveRecognizer(localeTag: String?) -> SFSpeechRecognizer? {
  let supported = SFSpeechRecognizer.supportedLocales()
  if let raw = localeTag?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
    if let resolved = resolveSupportedRecognizer(for: raw, supported: supported) {
      return resolved
    }
  }
  if let current = resolveSupportedRecognizer(for: Locale.current.identifier, supported: supported) {
    return current
  }
  return SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
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

@discardableResult
func bindAudioInputDevice(_ inputNode: AVAudioInputNode, deviceID: AudioDeviceID) -> OSStatus {
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
      return noErr
    }
    fputs("[imcodes-speech] AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice=\(deviceID)) failed: OSStatus=\(status)\n", stderr)
    do {
      try inputNode.auAudioUnit.setDeviceID(deviceID)
      return noErr
    } catch {
      fputs("[imcodes-speech] auAudioUnit.setDeviceID(\(deviceID)) fallback failed: \(error.localizedDescription)\n", stderr)
      return status
    }
  } else {
    fputs("[imcodes-speech] inputNode.audioUnit unavailable for device \(deviceID)\n", stderr)
    do {
      try inputNode.auAudioUnit.setDeviceID(deviceID)
      return noErr
    } catch {
      fputs("[imcodes-speech] auAudioUnit.setDeviceID(\(deviceID)) fallback failed: \(error.localizedDescription)\n", stderr)
      return -1
    }
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

final class SpeechSession {
  private let audioEngine = AVAudioEngine()
  private let recognitionQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "com.imcodes.speech.recognition"
    queue.maxConcurrentOperationCount = 1
    queue.qualityOfService = .userInitiated
    return queue
  }()
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private let lock = NSLock()
  private var stopped = false
  private var finished = false
  private var loggedFirstResult = false
  private var loggedTaskError = false
  private var lastLevelEmit = Date.distantPast
  private var latestText = ""

  private func isFinished() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return finished
  }

  func run(localeTag: String?, deviceUID: String?) -> Int32 {
    let micStatus = requestMicIfNeeded()
    if micStatus != .authorized {
      emitJson([
        "type": "error",
        "code": "permission_denied",
        "target": "mic",
        "mic": mapMicStatus(micStatus),
        "speech": mapSpeechStatus(SFSpeechRecognizer.authorizationStatus()),
      ])
      return 1
    }

    let speechStatus = requestSpeechIfNeeded()
    if speechStatus != .authorized {
      emitJson([
        "type": "error",
        "code": "permission_denied",
        "target": "speech",
        "mic": mapMicStatus(micStatus),
        "speech": mapSpeechStatus(speechStatus),
      ])
      return 1
    }

    guard let recognizer = resolveRecognizer(localeTag: localeTag), recognizer.isAvailable else {
      fputs("[imcodes-speech] recognizer unavailable locale=\(localeTag ?? "default")\n", stderr)
      emitJson([
        "type": "error",
        "code": "speech_unavailable",
      ])
      return 1
    }
    recognizer.queue = recognitionQueue
    self.recognizer = recognizer
    fputs("[imcodes-speech] recognizer locale=\(recognizer.locale.identifier) requested=\(localeTag ?? "default") available=\(recognizer.isAvailable)\n", stderr)

    let inputNode = audioEngine.inputNode
    let targetInputID = resolveInputDeviceID(deviceUID: deviceUID)
    let bindStatus: OSStatus = targetInputID.map { bindAudioInputDevice(inputNode, deviceID: $0) } ?? -1
    let format = inputNode.outputFormat(forBus: 0)
    fputs("[imcodes-speech] input deviceID=\(targetInputID.map(String.init) ?? "none") bindStatus=\(bindStatus) sampleRate=\(format.sampleRate) channels=\(format.channelCount)\n", stderr)
    guard format.channelCount > 0, format.sampleRate > 0 else {
      emitJson([
        "type": "error",
        "code": "no_audio_input",
      ])
      return 1
    }

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if #available(macOS 13.0, *) {
      req.addsPunctuation = true
    }
    request = req

    inputNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
      guard let self = self else { return }
      req.append(buffer)
      self.maybeEmitLevel(buffer: buffer)
    }

    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      fputs("[imcodes-speech] audioEngine.start failed: \(error.localizedDescription)\n", stderr)
      inputNode.removeTap(onBus: 0)
      emitJson([
        "type": "error",
        "code": "audio_engine_failed",
        "message": error.localizedDescription,
      ])
      return 1
    }

    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      guard let self = self else { return }
      if let result = result {
        let text = result.bestTranscription.formattedString
        self.lock.lock()
        let shouldLogFirst = !self.loggedFirstResult
        if shouldLogFirst {
          self.loggedFirstResult = true
        }
        self.latestText = text
        self.lock.unlock()
        if shouldLogFirst {
          fputs("[imcodes-speech] recognition callback delivered first result (isFinal=\(result.isFinal), len=\(text.count))\n", stderr)
        }
        emitJson([
          "type": "result",
          "text": text,
          "isFinal": result.isFinal,
        ])
        if result.isFinal {
          self.finish(emitEnd: true)
          return
        }
      }
      if let error = error {
        let nsErr = error as NSError
        // Ignore routine end-of-audio / no-speech cancellation once user requested stop.
        self.lock.lock()
        let wasStopped = self.stopped
        let shouldLogError = !self.loggedTaskError
        if shouldLogError {
          self.loggedTaskError = true
        }
        self.lock.unlock()
        if shouldLogError {
          fputs("[imcodes-speech] recognition callback error: domain=\(nsErr.domain) code=\(nsErr.code) msg=\(nsErr.localizedDescription)\n", stderr)
        }
        let isNoSpeechOrCancelled = (nsErr.domain == "kAFAssistantErrorDomain" && (nsErr.code == 1110 || nsErr.code == 216 || nsErr.code == 203))
        if !wasStopped && !isNoSpeechOrCancelled {
          emitJson([
            "type": "error",
            "code": "recognition_failed",
            "message": error.localizedDescription,
          ])
        }
        self.finish(emitEnd: true)
      }
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

    // Pump RunLoop.main without busy-spinning so Speech/Audio XPC callbacks can service RunLoop.main if needed.
    let keepAliveTimer = Timer(timeInterval: 0.25, repeats: true) { _ in }
    RunLoop.main.add(keepAliveTimer, forMode: .default)
    defer { keepAliveTimer.invalidate() }
    while !isFinished() {
      RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.25))
    }
    return 0
  }

  private func maybeEmitLevel(buffer: AVAudioPCMBuffer) {
    let now = Date()
    if now.timeIntervalSince(lastLevelEmit) < 0.09 {
      return
    }
    let frameLength = Int(buffer.frameLength)
    if frameLength <= 0 { return }
    var sum: Double = 0
    if let channelData = buffer.floatChannelData?[0] {
      for i in 0..<frameLength {
        let s = Double(channelData[i])
        sum += s * s
      }
    } else if let int16Data = buffer.int16ChannelData?[0] {
      let scale = Double(Int16.max)
      for i in 0..<frameLength {
        let s = Double(int16Data[i]) / scale
        sum += s * s
      }
    } else if let int32Data = buffer.int32ChannelData?[0] {
      let scale = Double(Int32.max)
      for i in 0..<frameLength {
        let s = Double(int32Data[i]) / scale
        sum += s * s
      }
    } else {
      return
    }
    lastLevelEmit = now
    let rms = sqrt(sum / Double(frameLength))
    let normalized = min(1.0, rms * 4.0)
    emitJson(["type": "level", "value": normalized])
  }

  func stop(abort: Bool) {
    lock.lock()
    if stopped {
      lock.unlock()
      return
    }
    stopped = true
    lock.unlock()

    audioEngine.stop()
    audioEngine.inputNode.removeTap(onBus: 0)
    request?.endAudio()

    if abort {
      task?.cancel()
      finish(emitEnd: true)
      return
    }

    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(1500)) { [weak self] in
      self?.finish(emitEnd: true)
    }
  }

  private func finish(emitEnd: Bool) {
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
    if emitEnd {
      emitJson(["type": "end"])
    }
    CFRunLoopStop(CFRunLoopGetMain())
  }
}

// MARK: - Global Double-Tap Ctrl Hotkey Monitor

final class CtrlDoubleTapDetector {
  private let tapWindowSeconds: TimeInterval = 0.40
  private let maxHoldSeconds: TimeInterval = 0.35
  private let debounceSeconds: TimeInterval = 0.35

  private var ctrlDown = false
  private var ctrlDownAt: Date?
  private var otherKeyPressedWhileCtrlDown = false
  private var lastTapUpAt: Date?
  private var lastEmitAt = Date.distantPast

  func handleFlagsChanged(flags: NSEvent.ModifierFlags, keyCode: UInt16) -> Bool {
    // Only clean Control taps (no Shift/Option/Command/Fn mixed in)
    let extraModifiers: NSEvent.ModifierFlags = [.shift, .command, .option, .function]
    if !flags.intersection(extraModifiers).isEmpty {
      otherKeyPressedWhileCtrlDown = true
      lastTapUpAt = nil
    }

    let isCtrlNow = flags.contains(.control)
    let now = Date()

    if !ctrlDown && isCtrlNow && (keyCode == 59 || keyCode == 62 || flags.contains(.control)) {
      ctrlDown = true
      ctrlDownAt = now
      otherKeyPressedWhileCtrlDown = !flags.intersection(extraModifiers).isEmpty
      return false
    }

    if ctrlDown && !isCtrlNow {
      ctrlDown = false
      let heldDuration = ctrlDownAt.map { now.timeIntervalSince($0) } ?? (maxHoldSeconds + 1)
      ctrlDownAt = nil
      let wasCleanTap = !otherKeyPressedWhileCtrlDown && heldDuration <= maxHoldSeconds
      otherKeyPressedWhileCtrlDown = false

      if !wasCleanTap {
        lastTapUpAt = nil
        return false
      }

      if let prevUp = lastTapUpAt, now.timeIntervalSince(prevUp) <= tapWindowSeconds {
        lastTapUpAt = nil
        if now.timeIntervalSince(lastEmitAt) >= debounceSeconds {
          lastEmitAt = now
          return true
        }
        return false
      }

      lastTapUpAt = now
      return false
    }

    return false
  }

  func handleKeyDown() {
    if ctrlDown || lastTapUpAt != nil {
      otherKeyPressedWhileCtrlDown = true
      lastTapUpAt = nil
    }
  }
}

func runHotkeyCommand() -> Int32 {
  let app = NSApplication.shared
  app.setActivationPolicy(.prohibited)

  let detector = CtrlDoubleTapDetector()
  let lock = NSLock()

  var globalMonitor: Any?
  var localMonitor: Any?

  let processEvent: (NSEvent) -> Void = { event in
    lock.lock()
    defer { lock.unlock() }
    switch event.type {
    case .flagsChanged:
      if detector.handleFlagsChanged(flags: event.modifierFlags, keyCode: event.keyCode) {
        emitJson(["type": "toggle"])
      }
    case .keyDown:
      detector.handleKeyDown()
    default:
      break
    }
  }

  globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { event in
    processEvent(event)
  }
  localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { event in
    processEvent(event)
    return event
  }

  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  termSrc.setEventHandler { NSApp.terminate(nil) }
  termSrc.resume()
  let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
  intSrc.setEventHandler { NSApp.terminate(nil) }
  intSrc.resume()

  DispatchQueue.global(qos: .utility).async {
    while readLine(strippingNewline: true) != nil {}
    DispatchQueue.main.async {
      NSApp.terminate(nil)
    }
  }

  app.run()

  if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
  if let localMonitor { NSEvent.removeMonitor(localMonitor) }
  return 0
}

// MARK: - Non-Activating Floating Voice Overlay (NSPanel)

final class GlobalVoiceOverlayController {
  private let panelWidth: CGFloat = 364
  private let basePanelHeight: CGFloat = 56
  private let barCount = 16

  private let panel: NSPanel
  private let logoView = NSImageView()
  private let dotView = NSView()
  private let titleLabel = NSTextField(labelWithString: "")
  private let textLabel = NSTextField(wrappingLabelWithString: "")
  private var barViews: [NSView] = []
  private var barHistory: [Double] = []
  private var tickCount = 0
  private var loadedIconPath: String?
  private var hasLogo = false

  init(initialIconPath: String?) {
    let style: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]
    let p = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: basePanelHeight),
      styleMask: style,
      backing: .buffered,
      defer: false
    )
    p.isFloatingPanel = true
    p.becomesKeyOnlyIfNeeded = true
    p.hidesOnDeactivate = false
    p.ignoresMouseEvents = true
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.level = .popUpMenu
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    self.panel = p

    let container = NSView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: basePanelHeight))
    container.wantsLayer = true
    container.layer?.backgroundColor = NSColor(calibratedRed: 0.06, green: 0.09, blue: 0.16, alpha: 0.88).cgColor
    container.layer?.cornerRadius = 16
    container.layer?.borderWidth = 1
    container.layer?.borderColor = NSColor(calibratedWhite: 1.0, alpha: 0.16).cgColor
    p.contentView = container

    logoView.imageScaling = .scaleProportionallyUpOrDown
    logoView.wantsLayer = true
    logoView.layer?.cornerRadius = 7
    logoView.layer?.masksToBounds = true
    logoView.isHidden = true
    container.addSubview(logoView)

    dotView.wantsLayer = true
    dotView.layer?.cornerRadius = 4.5
    dotView.layer?.backgroundColor = NSColor.systemOrange.cgColor
    dotView.frame = NSRect(x: 16, y: 24, width: 9, height: 9)
    dotView.autoresizingMask = [.minYMargin]
    container.addSubview(dotView)

    titleLabel.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
    titleLabel.textColor = NSColor(calibratedWhite: 0.98, alpha: 1.0)
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.frame = NSRect(x: 32, y: 19, width: 128, height: 18)
    titleLabel.autoresizingMask = [.minYMargin]
    container.addSubview(titleLabel)

    let barsStartX: CGFloat = panelWidth - 16 - CGFloat(barCount) * 5.5
    for i in 0..<barCount {
      let bar = NSView(frame: NSRect(x: barsStartX + CGFloat(i) * 5.5, y: 24, width: 3, height: 4))
      bar.wantsLayer = true
      bar.layer?.cornerRadius = 1.5
      bar.layer?.backgroundColor = NSColor(calibratedRed: 0.13, green: 0.83, blue: 0.93, alpha: 0.85).cgColor
      bar.autoresizingMask = [.minYMargin]
      container.addSubview(bar)
      barViews.append(bar)
      barHistory.append(0)
    }

    textLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
    textLabel.textColor = NSColor(calibratedRed: 0.88, green: 0.92, blue: 0.98, alpha: 0.95)
    textLabel.maximumNumberOfLines = 2
    textLabel.lineBreakMode = .byTruncatingHead
    textLabel.isHidden = true
    container.addSubview(textLabel)

    applyIconPath(initialIconPath)
  }

  private func applyIconPath(_ rawPath: String?) {
    let trimmed = rawPath?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let path = trimmed, !path.isEmpty else { return }
    if loadedIconPath == path { return }
    loadedIconPath = path
    if let img = NSImage(contentsOfFile: path) {
      logoView.image = img
      logoView.isHidden = false
      hasLogo = true
    }
  }

  private func targetScreen() -> NSScreen? {
    let mouseLoc = NSEvent.mouseLocation
    if let hit = NSScreen.screens.first(where: { NSMouseInRect(mouseLoc, $0.frame, false) }) {
      return hit
    }
    return NSScreen.main ?? NSScreen.screens.first
  }

  private func reposition(height: CGFloat) {
    let frame = targetScreen()?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let x = round(frame.midX - panelWidth / 2)
    let y = round(frame.minY + 28)
    panel.setFrame(NSRect(x: x, y: y, width: panelWidth, height: height), display: true)
    panel.contentView?.frame = NSRect(x: 0, y: 0, width: panelWidth, height: height)
  }

  func show(state: String, title: String, text: String, level: Double, iconPath: String? = nil) {
    applyIconPath(iconPath)
    titleLabel.stringValue = title
    let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)

    if state == "loading" {
      dotView.layer?.backgroundColor = NSColor.systemOrange.cgColor
    } else if state == "draining" {
      dotView.layer?.backgroundColor = NSColor.systemYellow.cgColor
    } else {
      dotView.layer?.backgroundColor = NSColor(calibratedRed: 0.13, green: 0.83, blue: 0.93, alpha: 1.0).cgColor
    }

    let showBars = (state == "listening")
    if showBars {
      tickCount += 1
      let clamped = max(0.0, min(1.0, level))
      barHistory.removeFirst()
      barHistory.append(clamped)
    } else {
      barHistory = Array(repeating: 0.0, count: barCount)
    }

    let hasText = !trimmedText.isEmpty
    let textHeight: CGFloat = hasText ? 34 : 0
    let totalHeight = basePanelHeight + (hasText ? textHeight + 6 : 0)
    reposition(height: totalHeight)

    let topRowY = totalHeight - 36
    let contentLeftX: CGFloat = hasLogo ? 50 : 16
    if hasLogo {
      logoView.frame = NSRect(x: 14, y: topRowY - 3, width: 28, height: 28)
    }
    dotView.frame = NSRect(x: contentLeftX, y: topRowY + 5, width: 9, height: 9)
    titleLabel.frame = NSRect(x: contentLeftX + 15, y: topRowY + 1, width: panelWidth - contentLeftX - 15 - CGFloat(barCount) * 5.5 - 22, height: 18)

    let barsStartX: CGFloat = panelWidth - 16 - CGFloat(barCount) * 5.5
    for i in 0..<barCount {
      let bar = barViews[i]
      bar.isHidden = !showBars
      if showBars {
        let sample = barHistory[i]
        let centerDist = abs(Double(i) - Double(barCount - 1) / 2.0) / (Double(barCount - 1) / 2.0)
        let envelope = 1.0 - centerDist * 0.25
        let jitter = sample > 0.01 ? (0.85 + 0.15 * sin(Double(tickCount + i) * 0.9)) : 1.0
        let h = CGFloat(round(4.0 + min(1.0, sample * envelope * jitter) * 20.0))
        let y = topRowY + (20.0 - h) / 2.0
        bar.frame = NSRect(x: barsStartX + CGFloat(i) * 5.5, y: y, width: 3, height: h)
        bar.layer?.opacity = sample > 0.02 ? 1.0 : 0.45
      }
    }

    if hasText {
      textLabel.stringValue = trimmedText
      textLabel.isHidden = false
      textLabel.frame = NSRect(x: contentLeftX, y: 8, width: panelWidth - contentLeftX - 16, height: textHeight)
    } else {
      textLabel.stringValue = ""
      textLabel.isHidden = true
    }

    panel.orderFrontRegardless()
  }

  func hide() {
    panel.orderOut(nil)
  }
}

func runOverlayCommand(args: [String]) -> Int32 {
  var initialIconPath: String?
  var idx = 1
  while idx < args.count {
    if args[idx] == "--icon", idx + 1 < args.count {
      initialIconPath = args[idx + 1]
      idx += 2
    } else {
      idx += 1
    }
  }

  let app = NSApplication.shared
  app.setActivationPolicy(.prohibited)

  let controller = GlobalVoiceOverlayController(initialIconPath: initialIconPath)

  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  termSrc.setEventHandler {
    controller.hide()
    NSApp.terminate(nil)
  }
  termSrc.resume()
  let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
  intSrc.setEventHandler {
    controller.hide()
    NSApp.terminate(nil)
  }
  intSrc.resume()

  DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      guard let data = trimmed.data(using: .utf8),
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let cmd = obj["cmd"] as? String else {
        continue
      }
      DispatchQueue.main.async {
        if cmd == "hide" {
          controller.hide()
        } else if cmd == "show" {
          let state = (obj["state"] as? String) ?? "listening"
          let title = (obj["title"] as? String) ?? ""
          let text = (obj["text"] as? String) ?? ""
          let iconPath = obj["iconPath"] as? String
          let level = (obj["level"] as? Double) ?? (obj["level"] as? NSNumber)?.doubleValue ?? 0.0
          controller.show(state: state, title: title, text: text, level: level, iconPath: iconPath)
        }
      }
    }
    DispatchQueue.main.async {
      controller.hide()
      NSApp.terminate(nil)
    }
  }

  app.run()
  return 0
}

// MARK: - Accessibility Unicode Paste (16-UniChar Chunks)

func waitForControlRelease(timeoutSeconds: TimeInterval = 1.5) {
  let deadline = Date().addingTimeInterval(timeoutSeconds)
  while Date() < deadline {
    let leftCtrl = CGEventSource.keyState(.hidSystemState, key: 59)
    let rightCtrl = CGEventSource.keyState(.hidSystemState, key: 62)
    let flagsCtrl = CGEventSource.flagsState(.hidSystemState).contains(.maskControl)
    if !leftCtrl && !rightCtrl && !flagsCtrl {
      return
    }
    usleep(10_000)
  }
}

func runPasteCommand(args: [String]) -> Int32 {
  var prompt = false
  var useStdin = false
  var argText: String?
  var idx = 1
  while idx < args.count {
    if args[idx] == "--prompt" {
      prompt = true
      idx += 1
    } else if args[idx] == "--stdin" {
      useStdin = true
      idx += 1
    } else if args[idx] == "--text", idx + 1 < args.count {
      argText = args[idx + 1]
      idx += 2
    } else {
      idx += 1
    }
  }

  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
  if !AXIsProcessTrustedWithOptions(options) {
    emitJson(["type": "error", "code": "accessibility_denied"])
    return 1
  }

  let text: String
  if let argText {
    text = argText
  } else if useStdin || !isatty(STDIN_FILENO).boolValue {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    text = String(data: data, encoding: .utf8) ?? ""
  } else {
    text = ""
  }

  waitForControlRelease()

  let utf16 = Array(text.utf16)
  if utf16.isEmpty {
    emitJson(["type": "ok", "length": 0])
    return 0
  }

  guard let source = CGEventSource(stateID: .hidSystemState) else {
    emitJson(["type": "error", "code": "event_source_failed"])
    return 1
  }

  var offset = 0
  let chunkSize = 16
  while offset < utf16.count {
    let end = min(offset + chunkSize, utf16.count)
    let chunk = Array(utf16[offset..<end])
    if let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
       let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
      chunk.withUnsafeBufferPointer { buf in
        if let base = buf.baseAddress {
          down.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: base)
          up.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: base)
        }
      }
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
    offset = end
    if offset < utf16.count {
      usleep(2_000)
    }
  }

  emitJson(["type": "ok", "length": utf16.count])
  return 0
}

private extension Int32 {
  var boolValue: Bool { self != 0 }
}

let args = Array(CommandLine.arguments.dropFirst())
let cmd = args.first ?? "status"

switch cmd {
case "status":
  emitJson(currentStatusPayload())
  exit(0)
case "request":
  _ = requestMicIfNeeded()
  _ = requestSpeechIfNeeded()
  emitJson(currentStatusPayload())
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
case "hotkey":
  exit(runHotkeyCommand())
case "overlay":
  exit(runOverlayCommand(args: args))
case "paste":
  exit(runPasteCommand(args: args))
case "listen":
  var localeTag: String?
  var deviceUID: String?
  var idx = 1
  while idx < args.count {
    if args[idx] == "--locale", idx + 1 < args.count {
      localeTag = args[idx + 1]
      idx += 2
    } else if args[idx] == "--device", idx + 1 < args.count {
      deviceUID = args[idx + 1]
      idx += 2
    } else {
      idx += 1
    }
  }
  let session = SpeechSession()
  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
  termSrc.setEventHandler { session.stop(abort: true) }
  termSrc.resume()
  let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
  intSrc.setEventHandler { session.stop(abort: true) }
  intSrc.resume()
  let code = session.run(localeTag: localeTag, deviceUID: deviceUID)
  exit(code)
default:
  emitJson(["type": "error", "code": "unknown_command", "command": cmd])
  exit(2)
}
