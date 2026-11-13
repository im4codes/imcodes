import Foundation
import MLX

/// Runs `body` with its own random key, for constructing a model whose random
/// init a checkpoint is about to overwrite.
///
/// Every `MLXRandom` draw splits the global key lazily, and a draw that is
/// never evaluated keeps its link of that split chain alive. Random init
/// followed by `update(parameters:)` never evaluates the init, so each model
/// load used to grow the global chain by a few hundred graph nodes for the
/// lifetime of the process. A throwaway key scopes the chain to this call.
public func withThrowawayRandomState<Result>(_ body: () throws -> Result) rethrows -> Result {
    try withRandomState(MLXRandom.RandomState(seed: 0), body: body)
}
