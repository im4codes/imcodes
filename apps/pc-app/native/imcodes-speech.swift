import AVFoundation
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

  func run(localeTag: String?) -> Int32 {
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

    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
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
    lastLevelEmit = now
    guard let channelData = buffer.floatChannelData?[0] else { return }
    let frameLength = Int(buffer.frameLength)
    if frameLength <= 0 { return }
    var sum: Float = 0
    for i in 0..<frameLength {
      let s = channelData[i]
      sum += s * s
    }
    let rms = sqrt(sum / Float(frameLength))
    let normalized = min(1.0, Double(rms * 4.0))
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
case "listen":
  var localeTag: String?
  var idx = 1
  while idx < args.count {
    if args[idx] == "--locale", idx + 1 < args.count {
      localeTag = args[idx + 1]
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
  let code = session.run(localeTag: localeTag)
  exit(code)
default:
  emitJson(["type": "error", "code": "unknown_command", "command": cmd])
  exit(2)
}
