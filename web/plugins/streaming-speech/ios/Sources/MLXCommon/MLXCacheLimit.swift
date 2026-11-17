import Foundation
import MLX

/// Bounds spare buffers independently of model weights and live inference arrays.
package enum MLXCacheLimitPolicy {
    package static func defaultCeiling(physicalMemoryBytes: Int) -> Int {
        max(0, min(2 * 1024 * 1024 * 1024, physicalMemoryBytes / 4))
    }
}

/// Owns the process-wide MLX cache ceiling for cooperating model runtimes.
/// Every model registers, even when another model or the caller already
/// configured a lower limit. Releasing a registration can then preserve
/// the remaining models' ceilings regardless of unload order.
package final class MLXCacheLimitCoordinator: @unchecked Sendable {
    package static let shared = MLXCacheLimitCoordinator(
        getLimit: { MLX.Memory.cacheLimit },
        setLimit: { MLX.Memory.cacheLimit = $0 })

    private let lock = NSLock()
    private let getLimit: () -> Int
    private let setLimit: (Int) -> Void
    private var ceilings: [UUID: Int] = [:]
    private var baselineLimit: Int?
    private var appliedLimit: Int?

    /// Injectable accessors keep ownership tests independent of Metal.
    package init(getLimit: @escaping () -> Int, setLimit: @escaping (Int) -> Void) {
        self.getLimit = getLimit
        self.setLimit = setLimit
    }

    package func acquireDefault(
        physicalMemoryBytes: Int = Int(ProcessInfo.processInfo.physicalMemory)
    ) -> Lease? {
        let ceiling = MLXCacheLimitPolicy.defaultCeiling(physicalMemoryBytes: physicalMemoryBytes)
        guard ceiling > 0 else { return nil }
        return acquire(ceiling: ceiling)
    }

    package func acquire(ceiling: Int) -> Lease? {
        // Zero is a valid request to disable caching, including during a generation stage.
        guard ceiling >= 0 else { return nil }
        lock.lock()
        defer { lock.unlock() }

        if ceilings.isEmpty {
            baselineLimit = getLimit()
            appliedLimit = baselineLimit
        }
        let id = UUID()
        ceilings[id] = ceiling
        updateLimit()
        return Lease(coordinator: self, id: id)
    }

    private func release(id: UUID) {
        lock.lock()
        defer { lock.unlock() }
        guard ceilings.removeValue(forKey: id) != nil else { return }
        updateLimit()
        if ceilings.isEmpty {
            baselineLimit = nil
            appliedLimit = nil
        }
    }

    /// A limit changed outside this coordinator becomes the new caller
    /// budget. In particular, unload must not undo a caller's tighter cap.
    private func updateLimit() {
        let current = getLimit()
        if current != appliedLimit {
            baselineLimit = current
        }
        let baseline = baselineLimit ?? current
        let target = min(baseline, ceilings.values.min() ?? baseline)
        if target != current {
            setLimit(target)
        }
        appliedLimit = target
    }

    package final class Lease: @unchecked Sendable {
        private let coordinator: MLXCacheLimitCoordinator
        private let id: UUID

        fileprivate init(coordinator: MLXCacheLimitCoordinator, id: UUID) {
            self.coordinator = coordinator
            self.id = id
        }

        /// Idempotent, so explicit unload and later destruction both work.
        package func release() {
            coordinator.release(id: id)
        }

        deinit {
            release()
        }
    }
}
