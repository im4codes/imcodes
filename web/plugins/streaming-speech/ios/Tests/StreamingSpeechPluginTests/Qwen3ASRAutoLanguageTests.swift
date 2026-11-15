import XCTest
@testable import AudioCommon
@testable import Qwen3ASR

final class Qwen3ASRAutoLanguageTests: XCTestCase {
    private func makeTokenizer(_ vocab: [String: Int], merges: [String] = []) throws -> Qwen3Tokenizer {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("vocab.json")
        let data = try JSONSerialization.data(withJSONObject: vocab)
        try data.write(to: url)
        if !merges.isEmpty {
            let mergesUrl = dir.appendingPathComponent("merges.txt")
            try ("#version: 0.2\n" + merges.joined(separator: "\n") + "\n")
                .write(to: mergesUrl, atomically: true, encoding: .utf8)
        }
        let tokenizer = Qwen3Tokenizer()
        try tokenizer.load(from: url)
        return tokenizer
    }

    func testBuildPromptOmitsAsrTextInAutoDetectModes() throws {
        let tok = try makeTokenizer([
            "language": 100,
            "\u{0120}Chinese": 101,
            "\u{0120}English": 102,
            "<asr_text>": Qwen3ASRTokens.asrTextTokenId,
            "你好": 200,
        ], merges: [
            "l a", "la n", "lan g", "lang u", "langu a", "langua g", "languag e",
            "\u{0120} C", "\u{0120}C h", "\u{0120}Ch i", "\u{0120}Chi n", "\u{0120}Chin e", "\u{0120}Chine s", "\u{0120}Chines e",
        ])
        let baseSuffix: [Int32] = [
            Qwen3ASRTokens.audioEndTokenId,
            Qwen3ASRTokens.imEndTokenId,
            Qwen3ASRTokens.newlineTokenId,
            Qwen3ASRTokens.imStartTokenId,
            Qwen3ASRTokens.assistantTokenId,
            Qwen3ASRTokens.newlineTokenId,
        ].map { Int32($0) }

        for autoLang in [nil, "", "   ", "auto", "AUTO"] as [String?] {
            let (_, suffix) = Qwen3ASRModel.buildPromptTokenIds(
                language: autoLang,
                context: nil,
                tokenizer: tok
            )
            XCTAssertEqual(suffix, baseSuffix, "Auto language \(String(describing: autoLang)) must end at assistant newline")
        }

        // Rollback prefix already contains `language Chinese<asr_text>你好`; prompt must not prepend another `<asr_text>`.
        let rollbackPrefix: [Int32] = [100, 101, Int32(Qwen3ASRTokens.asrTextTokenId), 200]
        let (_, autoContSuffix) = Qwen3ASRModel.buildPromptTokenIds(
            language: nil,
            context: nil,
            tokenizer: tok,
            prefixTokens: rollbackPrefix
        )
        XCTAssertEqual(autoContSuffix, baseSuffix + rollbackPrefix)
        XCTAssertEqual(
            autoContSuffix.filter { $0 == Int32(Qwen3ASRTokens.asrTextTokenId) }.count,
            1
        )

        // Forced mode (`zh-Hans`) still appends `language Chinese<asr_text>`.
        let (_, forcedSuffix) = Qwen3ASRModel.buildPromptTokenIds(
            language: "zh-Hans",
            context: nil,
            tokenizer: tok
        )
        XCTAssertEqual(forcedSuffix, baseSuffix + [100, 101, Int32(Qwen3ASRTokens.asrTextTokenId)])
    }

    func testDecodeTokenBatchHandlesAutoHeaderAndForcedPlainText() throws {
        let tok = try makeTokenizer([
            "language": 100,
            " Chinese": 101,
            " English": 102,
            " None": 103,
            "<asr_text>": Qwen3ASRTokens.asrTextTokenId,
            "你好": 200,
            "language barrier": 201,
        ])
        let asr = Int32(Qwen3ASRTokens.asrTextTokenId)

        // Auto mode complete header + Chinese text
        XCTAssertEqual(
            Qwen3ASRModel.decodeTokenBatch(
                allTokens: [[100, 101, asr, 200]],
                tokenizer: tok,
                expectLanguageHeader: true
            ),
            ["你好"]
        )
        // Auto mode silent `language None<asr_text>`
        XCTAssertEqual(
            Qwen3ASRModel.decodeTokenBatch(
                allTokens: [[100, 103, asr]],
                tokenizer: tok,
                expectLanguageHeader: true
            ),
            [""]
        )
        // Auto mode incomplete pre-`<asr_text>` stub must never leak "language English"
        XCTAssertEqual(
            Qwen3ASRModel.decodeTokenBatch(
                allTokens: [[100, 102]],
                tokenizer: tok,
                expectLanguageHeader: true
            ),
            [""]
        )
        // Forced mode keeps legitimate text starting with "language ..."
        XCTAssertEqual(
            Qwen3ASRModel.decodeTokenBatch(
                allTokens: [[201]],
                tokenizer: tok,
                expectLanguageHeader: false
            ),
            ["language barrier"]
        )
    }

    func testSafePrefixTokensForRollbackInAutoMode() throws {
        let tok = try makeTokenizer([
            "language": 100,
            " Chinese": 101,
            "<asr_text>": Qwen3ASRTokens.asrTextTokenId,
            "今": 200,
            "天": 201,
            "真": 202,
            "好": 203,
        ])
        let asr = Int32(Qwen3ASRTokens.asrTextTokenId)

        // Before `<asr_text>` arrives in auto mode, never keep an incomplete header prefix
        XCTAssertEqual(
            Qwen3ASRModel.safePrefixTokensForRollback(
                [100, 101],
                rollbackCount: 1,
                tokenizer: tok,
                expectLanguageHeader: true
            ),
            []
        )

        // With complete header + content tokens, preserves header (`language Chinese<asr_text>`) + trimmed prefix
        XCTAssertEqual(
            Qwen3ASRModel.safePrefixTokensForRollback(
                [100, 101, asr, 200, 201, 202, 203],
                rollbackCount: 2,
                tokenizer: tok,
                expectLanguageHeader: true
            ),
            [100, 101, asr, 200, 201]
        )
    }
}
