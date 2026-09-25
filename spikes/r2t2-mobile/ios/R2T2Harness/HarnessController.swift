import Foundation
import UIKit

@MainActor
final class HarnessController: ObservableObject {
    @Published var status = "Idle"
    @Published var modelInfo = "No model found in Documents"
    @Published var loadReport: [String: Any] = [:]
    @Published var lastReport: [String: Any] = [:]
    @Published var liveText = ""
    @Published var busy = false
    @Published var liveRunning = false
    @Published var chunkMs = 160
    @Published var language = "auto"
    @Published var useGPU = true
    @Published var sample = "zh_upstream_test"

    let samples = ["zh_upstream_test", "en_tts", "zh_quiet_onset"]
    let languages = ["auto", "Chinese", "English"]
    let chunkOptions = [160, 320, 640, 1000]

    private let harness = Harness()
    private let work = DispatchQueue(label: "r2t2.harness", qos: .userInitiated)
    private var live: Harness.Live?
    private var mic: LiveMic?
    private var deviceLog: DeviceLog?
    private var liveAudioSec = 0.0
    private var liveBacklog = 0.0

    init() { refreshModel() }

    var langArg: String? { language == "auto" ? nil : language }

    func refreshModel() {
        if let found = ModelStore.locate() {
            modelInfo = "\(found.model.lastPathComponent)\n\(found.mmproj.lastPathComponent)"
        } else {
            modelInfo = "No model found. Copy both .gguf files into Files > R2T2 Spike, or tap Download."
        }
    }

    func download(endpoint: String) {
        busy = true
        status = "Downloading…"
        Task {
            do {
                for file in [ModelPins.mmproj, ModelPins.model] {
                    let dl = PinnedDownloader(file: file) { p in
                        Task { @MainActor in self.status = String(format: "Downloading %@ %.0f%%", file.name, p * 100) }
                    }
                    try await dl.run(endpoint: endpoint)
                }
                status = "Download verified (size + SHA-256)"
            } catch {
                status = "Download failed: \(error.localizedDescription)"
            }
            busy = false
            refreshModel()
        }
    }

    func load() {
        guard let found = ModelStore.locate() else { status = "No model files"; return }
        busy = true
        status = "Loading…"
        let gpu = useGPU
        work.async {
            let json = self.harness.load(model: found.model, mmproj: found.mmproj, gpu: gpu)
            Task { @MainActor in
                self.loadReport = Self.parse(json)
                self.status = self.harness.isLoaded ? "Loaded" : "Load failed"
                self.save(kind: "load", json: json)
                self.busy = false
            }
        }
    }

    private func samplePCM() -> [Float]? {
        guard let url = Bundle.main.url(forResource: sample, withExtension: "wav", subdirectory: "samples") else { return nil }
        return Harness.readWav(url)
    }

    func runOneshot() {
        guard let pcm = samplePCM() else { status = "sample missing"; return }
        run(kind: "oneshot") { self.harness.oneshot(pcm, language: self.langArg) }
    }

    func runStream(realtime: Bool, repeatSeconds: Double, kind: String) {
        guard let pcm = samplePCM() else { status = "sample missing"; return }
        let chunk = Int32(chunkMs)
        let lang = langArg
        var log: DeviceLog?
        if repeatSeconds > 0 {
            log = DeviceLog(name: kind)
            log?.start(every: 30) { (0, 0) }
        }
        run(kind: kind) {
            let json = self.harness.stream(pcm, language: lang, chunkMs: chunk, realtime: realtime,
                                           repeatSeconds: repeatSeconds) { event in
                if let e = Self.parse(event) as [String: Any]?, let committed = e["committed"] as? String {
                    Task { @MainActor in self.liveText = committed }
                }
            }
            log?.stop()
            return json
        }
    }

    private func run(kind: String, _ body: @escaping () -> String) {
        guard harness.isLoaded else { status = "Load the model first"; return }
        busy = true
        status = "Running \(kind)…"
        UIApplication.shared.isIdleTimerDisabled = true
        work.async {
            let json = body()
            Task { @MainActor in
                self.lastReport = Self.parse(json)
                self.status = "\(kind) done"
                self.save(kind: kind, json: json)
                self.busy = false
                UIApplication.shared.isIdleTimerDisabled = false
            }
        }
    }

    func cancel() { harness.cancel() }

    // MARK: live microphone (sustained / locked-screen)

    func startLive() {
        guard harness.isLoaded else { status = "Load the model first"; return }
        liveText = ""
        liveAudioSec = 0
        liveBacklog = 0
        guard let session = harness.startLive(language: langArg, chunkMs: Int32(chunkMs), maxUtteranceSec: 30, onEvent: { event in
            let e = Self.parse(event)
            Task { @MainActor in
                if let a = e["audio_sec"] as? Double { self.liveAudioSec = a }
                if let b = e["backlog_sec"] as? Double { self.liveBacklog = b }
                if let c = e["committed"] as? String, (e["type"] as? String) == "commit" { self.liveText = c }
                if let f = e["final_text"] as? String, !f.isEmpty { self.status = "utterance: \(f)" }
            }
        }) else { status = "live start failed"; return }
        live = session
        let mic = LiveMic()
        do {
            try mic.start { samples in session.push(samples) }
        } catch {
            status = "mic failed: \(error.localizedDescription)"
            _ = session.stop()
            live = nil
            return
        }
        self.mic = mic
        let log = DeviceLog(name: "live")
        log.start(every: 30) { [weak self] in
            guard let self else { return (0, 0) }
            return MainActor.assumeIsolated { (self.liveAudioSec, self.liveBacklog) }
        }
        deviceLog = log
        liveRunning = true
        status = "Live: speak, or lock the screen for the battery run"
    }

    func stopLive() {
        mic?.stop()
        mic = nil
        deviceLog?.stop()
        let csv = deviceLog?.url.lastPathComponent ?? ""
        deviceLog = nil
        let json = live?.stop() ?? "{}"
        live = nil
        liveRunning = false
        lastReport = Self.parse(json)
        save(kind: "live", json: json)
        status = "Live stopped. Device log: \(csv)"
    }

    // MARK: results

    private func save(kind: String, json: String) {
        let dir = ModelStore.documents.appendingPathComponent("results", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let device = UIDevice.current
        let header = "{\"kind\":\"\(kind)\",\"device\":\"\(Self.machine())\",\"os\":\"\(device.systemName) \(device.systemVersion)\","
            + "\"thermal\":\"\(DeviceLog.thermal)\",\"chunk_ms\":\(chunkMs),\"gpu\":\(useGPU),\"sample\":\"\(sample)\",\"report\":"
        let line = header + json + "}\n"
        let url = dir.appendingPathComponent("runs.jsonl")
        if let h = try? FileHandle(forWritingTo: url) {
            _ = try? h.seekToEnd()
            h.write(line.data(using: .utf8)!)
            try? h.close()
        } else {
            FileManager.default.createFile(atPath: url.path, contents: line.data(using: .utf8))
        }
    }

    static func machine() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    nonisolated static func parse(_ json: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? ["raw": json]
    }
}
