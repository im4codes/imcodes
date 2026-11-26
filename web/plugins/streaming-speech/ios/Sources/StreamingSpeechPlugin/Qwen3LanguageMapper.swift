import Foundation
import Qwen3ASR

enum Qwen3LanguageMapper {
    /// Maps a BCP-47 locale tag or canonical language name to the canonical Qwen3-ASR
    /// language string, or returns `nil` for auto-detect (`nil`, empty, `"auto"`, or unknown).
    static func resolve(_ raw: String?) -> String? {
        Qwen3ASRModel.resolveLanguage(raw)
    }
}
