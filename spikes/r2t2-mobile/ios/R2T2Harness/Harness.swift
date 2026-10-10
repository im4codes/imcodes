import Foundation

/// Thin Swift wrapper over the shared C API (core/r2t2_harness.h).
/// All calls block; run them off the main thread.
final class Harness {
    private var handle: OpaquePointer?

    static func takeString(_ p: UnsafeMutablePointer<CChar>?) -> String {
        guard let p else { return "{}" }
        defer { r2t2_free_string(p) }
        return String(cString: p)
    }

    /// Returns the load report JSON; `isLoaded` tells whether it succeeded.
    func load(model: URL, mmproj: URL, threads: Int32 = 0, ctx: Int32 = 4096, gpu: Bool = true) -> String {
        unload()
        var out: OpaquePointer?
        let json: String = model.path.withCString { m in
            mmproj.path.withCString { p in
                var params = r2t2_harness_params(model_path: m, mmproj_path: p, n_threads: threads, n_ctx: ctx,
                                                 use_gpu: gpu ? 1 : 0, n_gpu_layers: gpu ? -1 : 0)
                return Harness.takeString(r2t2_harness_load(&params, &out))
            }
        }
        handle = out
        return json
    }

    var isLoaded: Bool { handle != nil }

    func unload() {
        if let handle { r2t2_harness_free(handle) }
        handle = nil
    }

    func oneshot(_ pcm: [Float], language: String?) -> String {
        guard let handle else { return #"{"error":"not loaded"}"# }
        return pcm.withUnsafeBufferPointer { buf in
            Harness.withOptionalCString(language) { lang in
                Harness.takeString(r2t2_harness_oneshot(handle, buf.baseAddress, buf.count, lang, 4096))
            }
        }
    }

    /// Streams `pcm` through the ported stream_llama loop. `onEvent` receives
    /// per-step JSON on the calling (background) thread.
    func stream(_ pcm: [Float], language: String?, chunkMs: Int32, lookaheadMs: Int32 = 160,
                realtime: Bool, repeatSeconds: Double, onEvent: @escaping (String) -> Void) -> String {
        guard let handle else { return #"{"error":"not loaded"}"# }
        let box = Unmanaged.passRetained(EventBox(onEvent))
        defer { box.release() }
        return pcm.withUnsafeBufferPointer { buf in
            Harness.withOptionalCString(language) { lang in
                Harness.takeString(r2t2_harness_stream(handle, buf.baseAddress, buf.count, lang, chunkMs, lookaheadMs, 1,
                                                       realtime ? 1 : 0, repeatSeconds, eventTrampoline, box.toOpaque()))
            }
        }
    }

    func cancel() {
        if let handle { r2t2_harness_cancel(handle) }
    }

    // MARK: live microphone session

    final class Live {
        fileprivate let ptr: OpaquePointer
        fileprivate let box: Unmanaged<EventBox>
        fileprivate init(ptr: OpaquePointer, box: Unmanaged<EventBox>) { self.ptr = ptr; self.box = box }
        func push(_ samples: UnsafeBufferPointer<Float>) { r2t2_live_push(ptr, samples.baseAddress, samples.count) }
        func stop() -> String {
            let json = Harness.takeString(r2t2_live_stop(ptr))
            box.release()
            return json
        }
    }

    func startLive(language: String?, chunkMs: Int32, maxUtteranceSec: Double,
                   onEvent: @escaping (String) -> Void) -> Live? {
        guard let handle else { return nil }
        let box = Unmanaged.passRetained(EventBox(onEvent))
        let ptr: OpaquePointer? = Harness.withOptionalCString(language) { lang in
            r2t2_live_start(handle, lang, chunkMs, 160, 1, maxUtteranceSec, eventTrampoline, box.toOpaque())
        }
        guard let ptr else { box.release(); return nil }
        return Live(ptr: ptr, box: box)
    }

    static func readWav(_ url: URL) -> [Float]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return data.withUnsafeBytes { raw -> [Float]? in
            var n = 0
            var err: UnsafeMutablePointer<CChar>?
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress,
                  let p = r2t2_read_wav_memory(base, raw.count, &n, &err) else {
                _ = takeString(err)
                return nil
            }
            defer { r2t2_free_floats(p) }
            return Array(UnsafeBufferPointer(start: p, count: n))
        }
    }

    private static func withOptionalCString<T>(_ s: String?, _ body: (UnsafePointer<CChar>?) -> T) -> T {
        guard let s, !s.isEmpty else { return body(nil) }
        return s.withCString { body($0) }
    }

    deinit { unload() }
}

final class EventBox {
    let handler: (String) -> Void
    init(_ handler: @escaping (String) -> Void) { self.handler = handler }
}

private let eventTrampoline: r2t2_progress_cb = { json, user in
    guard let json, let user else { return }
    Unmanaged<EventBox>.fromOpaque(user).takeUnretainedValue().handler(String(cString: json))
}
