import Foundation
import MLXCommon
import MLX
import MLXNN
import MLXFast
import AudioCommon

/// Multi-head attention for Qwen3 text decoder with GQA and RoPE (quantized version)
public class QuantizedTextAttention: Module {
    let numHeads: Int
    let numKVHeads: Int
    let headDim: Int
    let scale: Float

    @ModuleInfo var qProj: QuantizedLinear
    @ModuleInfo var kProj: QuantizedLinear
    @ModuleInfo var vProj: QuantizedLinear
    @ModuleInfo var oProj: QuantizedLinear
    @ModuleInfo var qNorm: RMSNorm
    @ModuleInfo var kNorm: RMSNorm

    let rope: MLXNN.RoPE

    public init(config: TextDecoderConfig) {
        self.numHeads = config.numHeads
        self.numKVHeads = config.numKVHeads
        self.headDim = config.headDim
        self.scale = 1.0 / sqrt(Float(headDim))

        let hiddenSize = config.hiddenSize

        // Create quantized linear layers
        self._qProj.wrappedValue = QuantizedLinear.preQuantized(
            hiddenSize, numHeads * headDim, bias: false,
            groupSize: config.groupSize, bits: config.bits)
        self._kProj.wrappedValue = QuantizedLinear.preQuantized(
            hiddenSize, numKVHeads * headDim, bias: false,
            groupSize: config.groupSize, bits: config.bits)
        self._vProj.wrappedValue = QuantizedLinear.preQuantized(
            hiddenSize, numKVHeads * headDim, bias: false,
            groupSize: config.groupSize, bits: config.bits)
        self._oProj.wrappedValue = QuantizedLinear.preQuantized(
            numHeads * headDim, hiddenSize, bias: false,
            groupSize: config.groupSize, bits: config.bits)

        // Q/K normalization (Qwen3 specific)
        self._qNorm.wrappedValue = RMSNorm(dimensions: headDim, eps: config.rmsNormEps)
        self._kNorm.wrappedValue = RMSNorm(dimensions: headDim, eps: config.rmsNormEps)

        // MLXFast RoPE: split-half rotation (traditional=false), base from config
        self.rope = MLXNN.RoPE(dimensions: headDim, traditional: false, base: config.ropeTheta)

        super.init()
    }

    private func projectQKV(_ hiddenStates: MLXArray, offset: Int) -> (MLXArray, MLXArray, MLXArray) {
        let (batch, seqLen, _) = (hiddenStates.dim(0), hiddenStates.dim(1), hiddenStates.dim(2))

        let queries = qNorm(qProj(hiddenStates).reshaped(batch, seqLen, numHeads, headDim)).transposed(0, 2, 1, 3)
        let keys = kNorm(kProj(hiddenStates).reshaped(batch, seqLen, numKVHeads, headDim)).transposed(0, 2, 1, 3)
        let values = vProj(hiddenStates).reshaped(batch, seqLen, numKVHeads, headDim).transposed(0, 2, 1, 3)

        return (rope(queries, offset: offset), rope(keys, offset: offset), values)
    }

    public func callAsFunction(
        _ hiddenStates: MLXArray,
        attentionMask: MLXArray? = nil,
        cache: (MLXArray, MLXArray)? = nil
    ) -> (MLXArray, (MLXArray, MLXArray)) {
        let maskMode: MLXFast.ScaledDotProductAttentionMaskMode = attentionMask.map { .array($0) }
            ?? (hiddenStates.dim(1) == 1 ? .none : .causal)
        return callWithMaskMode(hiddenStates, maskMode: maskMode, cache: cache)
    }

    func callWithMaskMode(
        _ hiddenStates: MLXArray,
        maskMode: MLXFast.ScaledDotProductAttentionMaskMode,
        cache: (MLXArray, MLXArray)? = nil
    ) -> (MLXArray, (MLXArray, MLXArray)) {
        let offset = cache?.0.dim(2) ?? 0
        let (queries, keys, values) = projectQKV(hiddenStates, offset: offset)

        var cachedKeys = keys
        var cachedValues = values
        if let (prevKeys, prevValues) = cache {
            cachedKeys = concatenated([prevKeys, keys], axis: 2)
            cachedValues = concatenated([prevValues, values], axis: 2)
        }

        let merged = SDPA.attendAndMerge(
            qHeads: queries, kHeads: cachedKeys, vHeads: cachedValues,
            scale: scale, mask: maskMode)
        return (oProj(merged), (cachedKeys, cachedValues))
    }

    public func callWithKVCache(
        _ hiddenStates: MLXArray,
        maskMode: MLXFast.ScaledDotProductAttentionMaskMode,
        cache: TextLayerKVCache
    ) -> MLXArray {
        let (queries, keys, values) = projectQKV(hiddenStates, offset: cache.offset)
        let (cachedKeys, cachedValues) = cache.updateAndFetch(keys: keys, values: values)
        let merged = SDPA.attendAndMerge(
            qHeads: queries, kHeads: cachedKeys, vHeads: cachedValues,
            scale: scale, mask: maskMode)
        return oProj(merged)
    }
}

/// MLP for Qwen3 text decoder (SwiGLU activation, quantized)
/// Wraps the shared QuantizedMLP for backward compatibility
public class QuantizedTextMLP: Module {
    @ModuleInfo var gateProj: QuantizedLinear
    @ModuleInfo var upProj: QuantizedLinear
    @ModuleInfo var downProj: QuantizedLinear

    public init(config: TextDecoderConfig) {
        let hiddenSize = config.hiddenSize
        let intermediateSize = config.intermediateSize

        self._gateProj.wrappedValue = QuantizedLinear.preQuantized(
            hiddenSize, intermediateSize, bias: false,
            groupSize: config.groupSize, bits: config.bits)
        self._upProj.wrappedValue = QuantizedLinear.preQuantized(
            hiddenSize, intermediateSize, bias: false,
            groupSize: config.groupSize, bits: config.bits)
        self._downProj.wrappedValue = QuantizedLinear.preQuantized(
            intermediateSize, hiddenSize, bias: false,
            groupSize: config.groupSize, bits: config.bits)

        super.init()
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        // SwiGLU: down(silu(gate(x)) * up(x))
        let gate = silu(gateProj(x))
        let up = upProj(x)
        return downProj(gate * up)
    }
}

/// Decoder layer for Qwen3 text model (quantized)
public class QuantizedTextDecoderLayer: Module {
    @ModuleInfo var selfAttn: QuantizedTextAttention
    @ModuleInfo var mlp: QuantizedTextMLP
    @ModuleInfo var inputLayerNorm: RMSNorm
    @ModuleInfo var postAttentionLayerNorm: RMSNorm

    public init(config: TextDecoderConfig) {
        self._selfAttn.wrappedValue = QuantizedTextAttention(config: config)
        self._mlp.wrappedValue = QuantizedTextMLP(config: config)
        self._inputLayerNorm.wrappedValue = RMSNorm(dimensions: config.hiddenSize, eps: config.rmsNormEps)
        self._postAttentionLayerNorm.wrappedValue = RMSNorm(dimensions: config.hiddenSize, eps: config.rmsNormEps)

        super.init()
    }

    private lazy var compiledPostAttnMLP: ([MLXArray]) -> [MLXArray] = compile(inputs: [self], shapeless: true) {
        inputs in
        let residual = inputs[0]
        let attnOutput = inputs[1]
        let postAttn = residual + attnOutput
        let normed = self.postAttentionLayerNorm(postAttn)
        let gate = silu(self.mlp.gateProj(normed))
        let up = self.mlp.upProj(normed)
        return [postAttn + self.mlp.downProj(gate * up)]
    }

    public func callAsFunction(
        _ hiddenStates: MLXArray,
        attentionMask: MLXArray? = nil,
        cache: (MLXArray, MLXArray)? = nil
    ) -> (MLXArray, (MLXArray, MLXArray)) {
        let maskMode: MLXFast.ScaledDotProductAttentionMaskMode = attentionMask.map { .array($0) }
            ?? (hiddenStates.dim(1) == 1 ? .none : .causal)
        return callWithMaskMode(hiddenStates, maskMode: maskMode, cache: cache)
    }

    func callWithMaskMode(
        _ hiddenStates: MLXArray,
        maskMode: MLXFast.ScaledDotProductAttentionMaskMode,
        cache: (MLXArray, MLXArray)? = nil
    ) -> (MLXArray, (MLXArray, MLXArray)) {
        let hidden = inputLayerNorm(hiddenStates)
        let (attnOutput, newCache) = selfAttn.callWithMaskMode(hidden, maskMode: maskMode, cache: cache)
        return (compiledPostAttnMLP([hiddenStates, attnOutput])[0], newCache)
    }

    public func callWithKVCache(
        _ hiddenStates: MLXArray,
        maskMode: MLXFast.ScaledDotProductAttentionMaskMode,
        cache: TextLayerKVCache
    ) -> MLXArray {
        let hidden = inputLayerNorm(hiddenStates)
        let attnOutput = selfAttn.callWithKVCache(hidden, maskMode: maskMode, cache: cache)
        return compiledPostAttnMLP([hiddenStates, attnOutput])[0]
    }
}

/// Full Qwen3 text decoder model (quantized)
public class QuantizedTextModel: Module {
    public let config: TextDecoderConfig

    @ModuleInfo public var embedTokens: PreQuantizedEmbedding
    @ModuleInfo var layers: [QuantizedTextDecoderLayer]
    @ModuleInfo var norm: RMSNorm

    public init(config: TextDecoderConfig) {
        self.config = config

        self._embedTokens.wrappedValue = PreQuantizedEmbedding(
            embeddingCount: config.vocabSize,
            dimensions: config.hiddenSize,
            groupSize: config.groupSize,
            bits: config.bits)
        self._layers.wrappedValue = (0..<config.numLayers).map { _ in
            QuantizedTextDecoderLayer(config: config)
        }
        self._norm.wrappedValue = RMSNorm(dimensions: config.hiddenSize, eps: config.rmsNormEps)

        super.init()
    }

    public func makeKVCache(step: Int = 256) -> [TextLayerKVCache] {
        (0..<layers.count).map { _ in TextLayerKVCache(step: step) }
    }

    private func resolveEmbeddings(inputIds: MLXArray?, inputsEmbeds: MLXArray?) -> MLXArray {
        if let embeds = inputsEmbeds { return embeds }
        if let ids = inputIds { return embedTokens(ids) }
        fatalError("Either inputIds or inputsEmbeds must be provided")
    }

    /// Forward pass through text decoder using tuple caches (kept for ForcedAlignerTextDecoding).
    public func callAsFunction(
        inputIds: MLXArray? = nil,
        inputsEmbeds: MLXArray? = nil,
        attentionMask: MLXArray? = nil,
        cache: [(MLXArray, MLXArray)]? = nil
    ) -> (MLXArray, [(MLXArray, MLXArray)]) {
        var hiddenStates = resolveEmbeddings(inputIds: inputIds, inputsEmbeds: inputsEmbeds)
        let seqLen = hiddenStates.dim(1)
        let maskMode: MLXFast.ScaledDotProductAttentionMaskMode = attentionMask.map { .array($0) }
            ?? (seqLen == 1 ? .none : .causal)

        var newCache: [(MLXArray, MLXArray)] = []
        newCache.reserveCapacity(layers.count)
        for (i, layer) in layers.enumerated() {
            let (output, updatedCache) = layer.callWithMaskMode(hiddenStates, maskMode: maskMode, cache: cache?[i])
            hiddenStates = output
            newCache.append(updatedCache)
        }

        return (norm(hiddenStates), newCache)
    }

    /// Forward pass using step-preallocated KV caches and native causal SDPA masking.
    public func callWithKVCache(
        inputIds: MLXArray? = nil,
        inputsEmbeds: MLXArray? = nil,
        attentionMask: MLXArray? = nil,
        cache: [TextLayerKVCache]
    ) -> MLXArray {
        var hiddenStates = resolveEmbeddings(inputIds: inputIds, inputsEmbeds: inputsEmbeds)
        let seqLen = hiddenStates.dim(1)
        let maskMode: MLXFast.ScaledDotProductAttentionMaskMode = attentionMask.map { .array($0) }
            ?? (seqLen == 1 ? .none : .causal)

        for (i, layer) in layers.enumerated() {
            hiddenStates = layer.callWithKVCache(hiddenStates, maskMode: maskMode, cache: cache[i])
        }

        return norm(hiddenStates)
    }
}
