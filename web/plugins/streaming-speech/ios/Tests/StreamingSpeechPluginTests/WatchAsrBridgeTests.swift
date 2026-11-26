import XCTest
@testable import StreamingSpeechPlugin

final class WatchAsrBridgeTests: XCTestCase {
    func testDecodePcm16LittleEndianConvertsSamplesAndDropsTrailingOddByte() {
        // -32768 (0x00, 0x80), 0 (0x00, 0x00), +16384 (0x00, 0x40), trailing odd byte (0x7f)
        let bytes: [UInt8] = [0x00, 0x80, 0x00, 0x00, 0x00, 0x40, 0x7f]
        let samples = WatchAsrBridge.decodePcm16LittleEndian(Data(bytes))
        XCTAssertEqual(samples.count, 3)
        XCTAssertEqual(samples[0], -1.0, accuracy: 1e-5)
        XCTAssertEqual(samples[1], 0.0, accuracy: 1e-6)
        XCTAssertEqual(samples[2], 0.5, accuracy: 1e-5)
    }

    func testExtractPcm16FromWavParsesStandardAndChunkedWavOrRaw() {
        var wav = Data()
        func appendUInt32(_ v: UInt32) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { wav.append(contentsOf: $0) }
        }
        func appendUInt16(_ v: UInt16) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { wav.append(contentsOf: $0) }
        }

        let pcm = Data([0x01, 0x02, 0x03, 0x04])
        let junkPayload = Data([0xaa, 0xbb, 0xcc]) // odd-sized chunk (3 bytes + 1 pad byte)
        let riffBodySize = UInt32(4 + (8 + 16) + (8 + 4) + (8 + pcm.count))
        wav.append(contentsOf: "RIFF".utf8)
        appendUInt32(riffBodySize)
        wav.append(contentsOf: "WAVE".utf8)

        wav.append(contentsOf: "fmt ".utf8)
        appendUInt32(16)
        appendUInt16(1) // PCM
        appendUInt16(1) // mono
        appendUInt32(16000)
        appendUInt32(32000)
        appendUInt16(2)
        appendUInt16(16)

        wav.append(contentsOf: "JUNK".utf8)
        appendUInt32(UInt32(junkPayload.count))
        wav.append(junkPayload)
        wav.append(0x00) // pad byte

        wav.append(contentsOf: "data".utf8)
        appendUInt32(UInt32(pcm.count))
        wav.append(pcm)

        let parsed = WatchAsrBridge.extractPcm16FromWavOrRaw(wav)
        XCTAssertEqual(parsed?.sampleRate, 16000)
        XCTAssertEqual(parsed?.channels, 1)
        XCTAssertEqual(parsed?.pcm16, pcm)

        let rawFallback = WatchAsrBridge.extractPcm16FromWavOrRaw(pcm)
        XCTAssertEqual(rawFallback?.sampleRate, 16000)
        XCTAssertEqual(rawFallback?.channels, 1)
        XCTAssertEqual(rawFallback?.pcm16, pcm)
    }

    func testSpeechInboxSupportsZeroWarmupSamplesForExternalStreams() throws {
        var inbox = SpeechInbox(warmupSamples: 0)
        XCTAssertEqual(inbox.warmupRemaining, 0)
        let tone = (0..<1600).map { i in Float(0.2 * sin(2.0 * .pi * 220.0 * Double(i) / 16000.0)) }
        let scheduled = try inbox.offer(tone)
        XCTAssertTrue(scheduled)
        let batch = inbox.take()
        XCTAssertEqual(batch?.samples.count, 1600)
    }

    func testStartExternalStreamRejectsEmptyStreamIdOrPhoneMicBusy() {
        let invalid = WatchAsrBridge.shared.startExternalStream(streamId: "   ") { _ in }
        if case .failure(let err) = invalid {
            XCTAssertEqual(err, .invalidStreamId)
        } else {
            XCTFail("Expected invalidStreamId error, got \(invalid)")
        }

        SharedSpeechRecognizerStore.shared.setPhoneCaptureActive(true)
        defer { SharedSpeechRecognizerStore.shared.setPhoneCaptureActive(false) }

        let busy = WatchAsrBridge.shared.startExternalStream(streamId: UUID().uuidString) { _ in }
        if case .failure(let err) = busy {
            XCTAssertEqual(err, .phoneMicBusy)
        } else {
            XCTFail("Expected phoneMicBusy error, got \(busy)")
        }
    }
}
