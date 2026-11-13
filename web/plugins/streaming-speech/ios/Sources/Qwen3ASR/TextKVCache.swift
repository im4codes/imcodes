import Foundation
import MLX

/// Step-preallocated per-layer KV cache to avoid full tensor concatenation on every decode token.
public final class TextLayerKVCache {
    public private(set) var keys: MLXArray?
    public private(set) var values: MLXArray?
    public private(set) var offset: Int = 0
    private let step: Int

    public init(step: Int = 256) {
        self.step = max(16, step)
    }

    /// Append `[batch, numKVHeads, seqLen, headDim]` keys/values and return active views `[0..<offset]`.
    public func updateAndFetch(keys newKeys: MLXArray, values newValues: MLXArray) -> (MLXArray, MLXArray) {
        let prev = offset
        let seqLen = newKeys.dim(2)
        let needed = prev + seqLen

        if keys == nil || needed > keys!.dim(2) {
            let batch = newKeys.dim(0)
            let numKVHeads = newKeys.dim(1)
            let headDim = newKeys.dim(3)
            let newCap = ((needed + step - 1) / step) * step
            let kShape = [batch, numKVHeads, newCap, headDim]
            let newK = MLXArray.zeros(kShape, dtype: newKeys.dtype)
            let newV = MLXArray.zeros(kShape, dtype: newValues.dtype)
            if prev > 0, let oldK = keys, let oldV = values {
                newK[0..., 0..., 0..<prev, 0...] = oldK[0..., 0..., 0..<prev, 0...]
                newV[0..., 0..., 0..<prev, 0...] = oldV[0..., 0..., 0..<prev, 0...]
            }
            keys = newK
            values = newV
        }

        keys![0..., 0..., prev..<needed, 0...] = newKeys
        values![0..., 0..., prev..<needed, 0...] = newValues
        offset = needed

        return (keys![0..., 0..., 0..<needed, 0...], values![0..., 0..., 0..<needed, 0...])
    }

    /// Active KV views currently populated in this layer cache.
    public var activeSlices: (MLXArray, MLXArray)? {
        guard offset > 0, let k = keys, let v = values else { return nil }
        return (k[0..., 0..., 0..<offset, 0...], v[0..., 0..., 0..<offset, 0...])
    }
}
