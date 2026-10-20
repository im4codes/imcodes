import Foundation
import UIKit

/// Periodic battery / thermal / memory samples for the sustained and
/// locked-screen runs (task 1.4). Written as CSV into Documents/results/.
final class DeviceLog {
    private var timer: DispatchSourceTimer?
    private var handle: FileHandle?
    private let start = Date()
    let url: URL

    init(name: String) {
        let dir = ModelStore.documents.appendingPathComponent("results", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("\(name)-\(Self.stamp()).csv")
        FileManager.default.createFile(atPath: url.path,
                                       contents: "elapsed_s,battery_pct,battery_state,thermal_state,low_power,mem_mb,audio_s,backlog_s\n".data(using: .utf8))
        handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
    }

    static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: Date())
    }

    static var thermal: String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    /// `extra` supplies (audio seconds processed, backlog seconds) at sample time.
    func start(every seconds: Double = 30, extra: @escaping () -> (Double, Double)) {
        DispatchQueue.main.async { UIDevice.current.isBatteryMonitoringEnabled = true }
        let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        t.schedule(deadline: .now(), repeating: seconds)
        t.setEventHandler { [weak self] in self?.sample(extra()) }
        t.resume()
        timer = t
    }

    private func sample(_ extra: (Double, Double)) {
        var level: Float = -1
        var state = "unknown"
        DispatchQueue.main.sync {
            level = UIDevice.current.batteryLevel
            switch UIDevice.current.batteryState {
            case .charging: state = "charging"
            case .full: state = "full"
            case .unplugged: state = "unplugged"
            default: state = "unknown"
            }
        }
        let line = String(format: "%.0f,%.0f,%@,%@,%d,%.0f,%.1f,%.2f\n",
                          Date().timeIntervalSince(start), level * 100, state, Self.thermal,
                          ProcessInfo.processInfo.isLowPowerModeEnabled ? 1 : 0,
                          Double(r2t2_current_memory()) / 1_048_576, extra.0, extra.1)
        handle?.write(line.data(using: .utf8)!)
    }

    func stop() {
        timer?.cancel()
        timer = nil
        sample((0, 0))
        try? handle?.close()
        handle = nil
    }
}
