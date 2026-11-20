import XCTest
@testable import StreamingSpeechPlugin

final class TtsVoiceSelectionTests: XCTestCase {
    private func voice(
        _ identifier: String,
        name: String,
        language: String = "zh-CN",
        quality: TtsVoiceCandidate.QualityTier = .standard,
        isNovelty: Bool = false
    ) -> TtsVoiceCandidate {
        TtsVoiceCandidate(
            identifier: identifier,
            name: name,
            language: language,
            quality: quality,
            isNoveltyVoice: isNovelty
        )
    }

    func testPrefersCompactOverEloquenceNoveltyAndLegacyVoicesAtSameQuality() {
        let eddy = voice("com.apple.eloquence.zh-CN.Eddy", name: "Eddy")
        let legacy = voice("com.apple.speech.synthesis.voice.Albert", name: "Albert")
        let novelty = voice("com.apple.voice.compact.zh-CN.Weird", name: "Weird", isNovelty: true)
        let tingting = voice("com.apple.voice.compact.zh-CN.Tingting", name: "Tingting")

        let selected = TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eddy, legacy, novelty, tingting])
        XCTAssertEqual(selected, tingting)
    }

    func testPrefersCompactOverSuperCompactAndOtherDefault() {
        let genericDefault = voice("com.apple.ttsbundle.custom.zh-CN", name: "Generic")
        let superCompact = voice("com.apple.voice.super-compact.zh-CN.Tingting", name: "Tingting")
        let compact = voice("com.apple.voice.compact.zh-CN.Tingting", name: "Tingting")

        XCTAssertEqual(
            TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [genericDefault, superCompact, compact]),
            compact
        )
        XCTAssertEqual(
            TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [genericDefault, superCompact]),
            superCompact
        )
    }

    func testRespectsPremiumEnhancedSiriCompactHierarchy() {
        let eloquence = voice("com.apple.eloquence.zh-CN.Eddy", name: "Eddy", quality: .enhanced)
        let compact = voice("com.apple.voice.compact.zh-CN.Tingting", name: "Tingting")
        let siriDefault = voice("com.apple.ttsbundle.siri_yu-shu_zh-CN_compact", name: "Yushu")
        let enhanced = voice("com.apple.voice.enhanced.zh-CN.Tingting", name: "Tingting (Enhanced)", quality: .enhanced)
        let siriEnhanced = voice("com.apple.ttsbundle.siri_yu-shu_zh-CN_compact", name: "Yushu (Enhanced)", quality: .enhanced)
        let premium = voice("com.apple.voice.premium.zh-CN.Lili", name: "Lili (Premium)", quality: .premium)

        XCTAssertEqual(
            TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eloquence, compact, siriDefault]),
            siriDefault
        )
        XCTAssertEqual(
            TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eloquence, compact, siriDefault, enhanced]),
            enhanced
        )
        XCTAssertEqual(
            TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [enhanced, siriEnhanced]),
            siriEnhanced
        )
        XCTAssertEqual(
            TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eloquence, compact, siriDefault, enhanced, siriEnhanced, premium]),
            premium
        )
    }

    func testFallsBackToEloquenceWhenNoBetterCandidateAndPreservesExactRegionBeforePrimarySubtag() {
        let eddy = voice("com.apple.eloquence.zh-CN.Eddy", name: "Eddy")
        XCTAssertEqual(
            TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eddy]),
            eddy
        )

        let twEnhanced = voice("com.apple.voice.enhanced.zh-TW.Meijia", name: "Meijia", language: "zh-TW", quality: .enhanced)
        let cnCompact = voice("com.apple.voice.compact.zh-CN.Tingting", name: "Tingting", language: "zh-CN")
        XCTAssertEqual(
            TtsVoiceSelector.selectCandidate(for: "zh_CN", from: [twEnhanced, cnCompact]),
            cnCompact
        )
        XCTAssertEqual(
            TtsVoiceSelector.selectCandidate(for: "zh-HK", from: [twEnhanced, cnCompact]),
            twEnhanced
        )
        XCTAssertNil(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: []))
    }
}
