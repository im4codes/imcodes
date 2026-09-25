import SwiftUI

@main
struct R2T2HarnessApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @StateObject private var c = HarnessController()
    @State private var endpoint = "https://huggingface.co"

    var body: some View {
        NavigationStack {
            Form {
                Section("Model (app Documents)") {
                    Text(c.modelInfo).font(.footnote.monospaced())
                    Picker("Download source", selection: $endpoint) {
                        Text("huggingface.co").tag("https://huggingface.co")
                        Text("hf-mirror.com (CN)").tag("https://hf-mirror.com")
                    }
                    Button("Download pinned model (1.4 GB, verified)") { c.download(endpoint: endpoint) }
                        .disabled(c.busy)
                    Link("NetEase model license", destination: ModelPins.licenseURL)
                    Toggle("Metal GPU", isOn: $c.useGPU)
                    Button("Rescan Documents") { c.refreshModel() }
                    Button("Load model") { c.load() }.disabled(c.busy)
                    metric("load ms", c.loadReport["load_ms"])
                    metric("RAM after load MB", c.loadReport["mem_current_mb"])
                    metric("peak RAM MB", c.loadReport["mem_peak_mb"])
                }
                Section("Run on bundled sample") {
                    Picker("Sample", selection: $c.sample) { ForEach(c.samples, id: \.self) { Text($0) } }
                    Picker("Language", selection: $c.language) { ForEach(c.languages, id: \.self) { Text($0) } }
                    Picker("Chunk ms", selection: $c.chunkMs) { ForEach(c.chunkOptions, id: \.self) { Text("\($0)") } }
                    Button("1.2 One-shot") { c.runOneshot() }.disabled(c.busy)
                    Button("1.3 Streaming (fast)") { c.runStream(realtime: false, repeatSeconds: 0, kind: "stream") }.disabled(c.busy)
                    Button("1.4 Sustained 10 min (sample loop, real time)") {
                        c.runStream(realtime: true, repeatSeconds: 600, kind: "sustained10m")
                    }.disabled(c.busy)
                    Button("Cancel run", role: .destructive) { c.cancel() }.disabled(!c.busy)
                }
                Section("1.4 Live microphone (keeps running when locked)") {
                    if c.liveRunning {
                        Button("Stop live", role: .destructive) { c.stopLive() }
                    } else {
                        Button("Start live") { c.startLive() }.disabled(c.busy)
                    }
                    Text(c.liveText.isEmpty ? "—" : c.liveText).font(.body)
                }
                Section("Last result") {
                    metric("latency ms", c.lastReport["latency_ms"])
                    metric("decode tok/s", c.lastReport["tok_per_s"])
                    metric("RTF", c.lastReport["rtf"] ?? c.lastReport["compute_rtf"])
                    metric("step p50 / p90 ms", pair(c.lastReport["step_ms_p50"], c.lastReport["step_ms_p90"]))
                    metric("max lag ms", c.lastReport["max_lag_ms"] ?? c.lastReport["max_backlog_sec"])
                    metric("peak RAM MB", c.lastReport["mem_peak_mb"])
                    Text((c.lastReport["text"] ?? c.lastReport["final_text"] ?? c.lastReport["transcript"] ?? c.lastReport["error"] ?? "") as? String ?? "")
                        .font(.body)
                    Text("All runs append to Documents/results/runs.jsonl").font(.caption).foregroundStyle(.secondary)
                }
                Section { Text(c.status).font(.footnote) }
            }
            .navigationTitle("R2T2 spike")
        }
    }

    private func pair(_ a: Any?, _ b: Any?) -> String? {
        guard let a = a as? Double, let b = b as? Double else { return nil }
        return String(format: "%.0f / %.0f", a, b)
    }

    @ViewBuilder
    private func metric(_ name: String, _ value: Any?) -> some View {
        HStack {
            Text(name)
            Spacer()
            Text(format(value)).monospacedDigit().foregroundStyle(.secondary)
        }
    }

    private func format(_ v: Any?) -> String {
        switch v {
        case let d as Double: return String(format: "%.1f", d)
        case let i as Int: return "\(i)"
        case let s as String: return s
        default: return "—"
        }
    }
}
