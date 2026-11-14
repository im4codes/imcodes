import XCTest
@testable import StreamingSpeechPlugin

final class Qwen3LanguageMapperTests: XCTestCase {
    func testMapsUiLocalesToCanonicalQwen3LanguageNames() {
        XCTAssertEqual(Qwen3LanguageMapper.resolve("ja-JP"), "Japanese")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("ja"), "Japanese")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("zh-Hans"), "Chinese")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("zh-Hant"), "Chinese")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("zh-CN"), "Chinese")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("zh_TW"), "Chinese")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("en-US"), "English")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("ko-KR"), "Korean")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("es-ES"), "Spanish")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("ru-RU"), "Russian")
        XCTAssertEqual(Qwen3LanguageMapper.resolve("Japanese"), "Japanese")
    }

    func testReturnsNilForAutoDetectAndInvalidInputs() {
        XCTAssertNil(Qwen3LanguageMapper.resolve(nil))
        XCTAssertNil(Qwen3LanguageMapper.resolve(""))
        XCTAssertNil(Qwen3LanguageMapper.resolve("   "))
        XCTAssertNil(Qwen3LanguageMapper.resolve("auto"))
        XCTAssertNil(Qwen3LanguageMapper.resolve("AUTO"))
        XCTAssertNil(Qwen3LanguageMapper.resolve("xx-UNKNOWN"))
    }
}
