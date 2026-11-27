import XCTest
@testable import StreamingSpeechPlugin

final class HotwordsMergeTests: XCTestCase {
    func testRequestHotwordsTakePriorityOverFullStaticBase() {
        let fullBase = (1...60).map { "StaticTerm\($0)" }.joined(separator: ", ")
        let merged = SpeechDecoder.mergeHotwords(base: fullBase, request: "ProjectAlpha, ProjectBeta")
        XCTAssertNotNil(merged)
        let parts = (merged ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        XCTAssertEqual(parts.first, "ProjectAlpha")
        XCTAssertEqual(parts.dropFirst().first, "ProjectBeta")
        XCTAssertLessThanOrEqual(parts.count, 60)
        XCTAssertLessThanOrEqual((merged ?? "").count, 1000)
        XCTAssertFalse(parts.contains("StaticTerm60"))
    }

    func testEmptyOrNilRequestPreservesLegacyBaseVerbatimAcrossSessions() {
        let rawBase = "LegacyOne, legacyone, LegacyTwo, " + String(repeating: "x", count: 80)
        let sessionA = SpeechDecoder.mergeHotwords(base: rawBase, request: "ProjX")
        let sessionB = SpeechDecoder.mergeHotwords(base: rawBase, request: nil)
        let sessionBEmpty = SpeechDecoder.mergeHotwords(base: rawBase, request: "   \n  ")
        let sessionC = SpeechDecoder.mergeHotwords(base: rawBase, request: "ProjY")

        XCTAssertTrue((sessionA ?? "").hasPrefix("ProjX"))
        XCTAssertFalse((sessionA ?? "").contains("ProjY"))
        XCTAssertEqual(sessionB, rawBase)
        XCTAssertEqual(sessionBEmpty, rawBase)
        XCTAssertTrue((sessionC ?? "").hasPrefix("ProjY"))
        XCTAssertFalse((sessionC ?? "").contains("ProjX"))
    }
}
