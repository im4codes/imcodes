import Foundation
import MLX

/// Metal GPU memory budget utilities.
public enum MetalBudget {

    /// Query real Metal headroom: recommended working set minus active allocations.
    public static var availableBytes: Int? {
        let info = GPU.deviceInfo()
        let maxWorking = Int(info.maxRecommendedWorkingSetSize)
        guard maxWorking > 0 else { return nil }
        let active = Memory.activeMemory
        let overhead = 256 * 1024 * 1024  // 256 MB safety margin
        return max(0, maxWorking - active - overhead)
    }

    public static var totalMemory: Int {
        GPU.deviceInfo().memorySize
    }

    public static var maxRecommendedWorkingSet: Int {
        Int(GPU.deviceInfo().maxRecommendedWorkingSetSize)
    }

    public static var activeMemory: Int {
        Memory.activeMemory
    }

    @discardableResult
    public static func pinMemory(fraction: Double = 0.9) -> Int {
        Int(Double(maxRecommendedWorkingSet) * fraction)
    }

    @discardableResult
    public static func unpinMemory() -> Int {
        0
    }

    public static func canFit(modelBytes: Int) -> Bool {
        guard let available = availableBytes else { return true }
        return modelBytes <= available
    }
}
