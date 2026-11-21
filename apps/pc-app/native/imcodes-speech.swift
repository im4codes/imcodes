import AVFoundation
import CoreAudio
import Foundation
import Speech

func emitJson(_ dict: [String: Any]) {
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

func resolveRecognizer(localeTag: String?) -> SFSpeechRecognizer? {
  if let raw = localeTag?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
    if let exact = SFSpeechRecognizer(locale: Locale(identifier: raw)) {
      return exact
    }
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
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private let lock = NSLock()
  private var stopped = false
  private var finished = false
  private var lastLevelEmit = Date.distantPast
  private var latestText = ""
  private let doneSemaphore = DispatchSemaphore(value: 0)

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
      emitJson([
        "type": "error",
        "code": "speech_unavailable",
      ])
      return 1
    }

    let inputNode = audioEngine.inputNode
    if let targetInputID = resolveInputDeviceID(deviceUID: deviceUID) {
      try? inputNode.auAudioUnit.setDeviceID(targetInputID)
    }
    let format = inputNode.outputFormat(forBus: 0)
    guard format.channelCount > 0, format.sampleRate > 0 else {
      emitJson([
        "type": "error",
        "code": "no_audio_input",
      ])
      return 1
    }

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
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
        self.latestText = text
        self.lock.unlock()
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
        self.lock.unlock()
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

    _ = doneSemaphore.wait(timeout: .distantFuture)
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
    doneSemaphore.signal()
  }
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
