import Foundation

enum Qwen3LanguageMapper {
    private static let map: [String: String] = [
        "zh": "Chinese",
        "cmn": "Chinese",
        "chinese": "Chinese",
        "yue": "Cantonese",
        "cantonese": "Cantonese",
        "en": "English",
        "english": "English",
        "ja": "Japanese",
        "jp": "Japanese",
        "japanese": "Japanese",
        "ko": "Korean",
        "korean": "Korean",
        "es": "Spanish",
        "spanish": "Spanish",
        "ru": "Russian",
        "russian": "Russian",
        "fr": "French",
        "french": "French",
        "de": "German",
        "german": "German",
        "it": "Italian",
        "italian": "Italian",
        "pt": "Portuguese",
        "portuguese": "Portuguese",
        "ar": "Arabic",
        "arabic": "Arabic",
        "tr": "Turkish",
        "turkish": "Turkish",
        "vi": "Vietnamese",
        "vietnamese": "Vietnamese",
        "th": "Thai",
        "thai": "Thai",
        "id": "Indonesian",
        "indonesian": "Indonesian",
        "ms": "Malay",
        "malay": "Malay",
        "hi": "Hindi",
        "hindi": "Hindi",
        "nl": "Dutch",
        "dutch": "Dutch",
        "pl": "Polish",
        "polish": "Polish",
        "sv": "Swedish",
        "swedish": "Swedish",
        "da": "Danish",
        "danish": "Danish",
        "fi": "Finnish",
        "finnish": "Finnish",
        "cs": "Czech",
        "czech": "Czech",
        "el": "Greek",
        "greek": "Greek",
        "hu": "Hungarian",
        "hungarian": "Hungarian",
        "ro": "Romanian",
        "romanian": "Romanian",
        "fa": "Persian",
        "persian": "Persian",
        "fil": "Filipino",
        "tl": "Filipino",
        "filipino": "Filipino",
        "mk": "Macedonian",
        "macedonian": "Macedonian",
    ]

    /// Maps a BCP-47 locale tag or canonical language name to the canonical Qwen3-ASR
    /// language string, or returns `nil` for auto-detect (`nil`, empty, `"auto"`, or unknown).
    static func resolve(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        let normalized = trimmed.replacingOccurrences(of: "_", with: "-").lowercased()
        if normalized == "auto" {
            return nil
        }
        if let exact = map[normalized] {
            return exact
        }
        let primary = normalized.split(separator: "-", maxSplits: 1).first.map(String.init) ?? normalized
        return map[primary]
    }
}
