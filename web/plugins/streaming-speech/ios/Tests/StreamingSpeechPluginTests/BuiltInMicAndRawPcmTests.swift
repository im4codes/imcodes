import XCTest
@testable import StreamingSpeechPlugin

final class BuiltInMicAndRawPcmTests: XCTestCase {
    func testBuiltInMicRoutePolicyPrefersBuiltInMicOverHeadsetAndBluetooth() {
        let inputs = [
            AudioInputCandidate(uid: "bt-hfp-airpods", portType: "BluetoothHFP"),
            AudioInputCandidate(uid: "wired-headset", portType: "HeadsetMic"),
            AudioInputCandidate(uid: "iphone-bottom-mic", portType: BuiltInMicRoutePolicy.builtInMicPortType),
        ]

        XCTAssertEqual(
            BuiltInMicRoutePolicy.selectPreferredBuiltInMicUid(inputs: inputs, currentPreferredUid: "bt-hfp-airpods"),
            "iphone-bottom-mic"
        )
        XCTAssertNil(
            BuiltInMicRoutePolicy.selectPreferredBuiltInMicUid(inputs: inputs, currentPreferredUid: "iphone-bottom-mic")
        )
        XCTAssertNil(
            BuiltInMicRoutePolicy.selectPreferredBuiltInMicUid(
                inputs: [AudioInputCandidate(uid: "bt-hfp-airpods", portType: "BluetoothHFP")],
                currentPreferredUid: nil
            )
        )
    }

    func testBuiltInMicRoutePolicyReenforcesOnActiveOrWarmHoldSession() {
        XCTAssertTrue(BuiltInMicRoutePolicy.shouldReenforceOnRouteChange(hasActiveCapture: true, hasActiveRawPcmCapture: false, audioSessionActive: false))
        XCTAssertTrue(BuiltInMicRoutePolicy.shouldReenforceOnRouteChange(hasActiveCapture: false, hasActiveRawPcmCapture: true, audioSessionActive: false))
        XCTAssertTrue(BuiltInMicRoutePolicy.shouldReenforceOnRouteChange(hasActiveCapture: false, hasActiveRawPcmCapture: false, audioSessionActive: true))
        XCTAssertFalse(BuiltInMicRoutePolicy.shouldReenforceOnRouteChange(hasActiveCapture: false, hasActiveRawPcmCapture: false, audioSessionActive: false))

        XCTAssertTrue(BuiltInMicRoutePolicy.shouldInvalidateEngineOnRouteChange(reasonRawValue: 1, routeChangedFromBuiltIn: false))
        XCTAssertTrue(BuiltInMicRoutePolicy.shouldInvalidateEngineOnRouteChange(reasonRawValue: 2, routeChangedFromBuiltIn: false))
        XCTAssertTrue(BuiltInMicRoutePolicy.shouldInvalidateEngineOnRouteChange(reasonRawValue: 0, routeChangedFromBuiltIn: true))
        XCTAssertFalse(BuiltInMicRoutePolicy.shouldInvalidateEngineOnRouteChange(reasonRawValue: 0, routeChangedFromBuiltIn: false))
    }

    func testRawPcmChunkEncoderChunks1600SamplesIntoLittleEndianInt16Base64AndFlushesTail() {
        let encoder = RawPcmChunkEncoder()
        XCTAssertTrue(encoder.append(samples: Array(repeating: 0.25, count: 1000)).isEmpty)

        let emitted = encoder.append(samples: Array(repeating: -0.5, count: 800))
        XCTAssertEqual(emitted.count, 1)
        let chunkData = Data(base64Encoded: emitted[0].pcmBase64)
        XCTAssertEqual(chunkData?.count, RawPcmChunkEncoder.targetChunkSamples * 2)
        if let chunkData = chunkData {
            let firstSample = Int16(bitPattern: UInt16(chunkData[0]) | (UInt16(chunkData[1]) << 8))
            let sample1000 = Int16(bitPattern: UInt16(chunkData[1000 * 2]) | (UInt16(chunkData[1000 * 2 + 1]) << 8))
            XCTAssertEqual(firstSample, 8192)
            XCTAssertEqual(sample1000, -16384)
        }
        XCTAssertGreaterThan(emitted[0].level, 0.5)

        let tail = encoder.flush()
        XCTAssertNotNil(tail)
        XCTAssertEqual(Data(base64Encoded: tail!.pcmBase64)?.count, 200 * 2)
        XCTAssertNil(encoder.flush())
    }

    func testStreamingSpeechPcmCodecDecodesLittleEndianInt16AndRejectsInvalidBase64() {
        let samples: [Int16] = [0, 16384, -16384, Int16.max, Int16.min]
        var data = Data(capacity: samples.count * 2)
        for sample in samples {
            var le = sample.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        let decoded = StreamingSpeechPcmCodec.decodePcm16Base64(data.base64EncodedString())
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded!.count, samples.count)
        XCTAssertEqual(decoded![0], 0.0, accuracy: 1e-6)
        XCTAssertEqual(decoded![1], 0.5, accuracy: 1e-5)
        XCTAssertEqual(decoded![2], -0.5, accuracy: 1e-5)
        XCTAssertNil(StreamingSpeechPcmCodec.decodePcm16Base64("not-valid-base64!"))
        XCTAssertNil(StreamingSpeechPcmCodec.decodePcm16Base64(Data([0x01, 0x02, 0x03]).base64EncodedString()))
    }

    func testSpeechCoordinatorPrefillPreservesInitialPcmOrderWithoutWarmupClipping() {
        var events: [SpeechCoordinator.Event] = []
        let coordinator = SpeechCoordinator(
            worker: DispatchQueue(label: "test.worker"),
            emitQueue: DispatchQueue(label: "test.emit")
        ) { events.append($0) }

        let decodedBatchesLock = NSLock()
        var capturedSamples: [Float] = []
        let initial = (0..<1600).map { Float($0 + 1) * 0.0001 }
        let live = (0..<800).map { Float(2000 + $0) * 0.0001 }

        let owner = coordinator.beginStart(
            warmupSamples: 0,
            makeDecode: {
                SpeechCoordinator.Decoder(
                    decode: { samples, prefixTokens, _ in
                        decodedBatchesLock.lock()
                        capturedSamples = samples
                        decodedBatchesLock.unlock()
                        return ("hello world", prefixTokens)
                    },
                    rollbackPrefix: { prefix, _ in prefix }
                )
            },
            onStartReady: {},
            onSetupFailureTeardown: {}
        )

        coordinator.offerSamples(initial, owner: owner, onOverloadTeardown: {})
        coordinator.offerSamples(live, owner: owner, onOverloadTeardown: {})

        let stopExp = expectation(description: "stop completes")
        coordinator.endCapture(stopCompletion: { _ in stopExp.fulfill() }, stopAudio: {})
        wait(for: [stopExp], timeout: 5.0)

        decodedBatchesLock.lock()
        let decodedCount = capturedSamples.count
        let firstVal = capturedSamples.first ?? 0
        decodedBatchesLock.unlock()

        // No 320-sample warmup clipping; all initial + live samples decoded together in order.
        XCTAssertEqual(decodedCount, initial.count + live.count)
        XCTAssertGreaterThan(firstVal, 0)
        XCTAssertTrue(events.contains(.final("hello world")))
    }

    func testStreamingSpeechPcmCodecTranscribeOfflineSamplesFeedsChunksAndFinalTail() throws {
        var decodedInputs: [[Float]] = []
        let totalSamples = 20_000
        let pcm = (0..<totalSamples).map { Float(sin(Double($0) * 0.05)) * 0.2 }

        let text = try StreamingSpeechPcmCodec.transcribeOfflineSamples(
            pcm,
            rollbackPrefix: { tokens, _ in tokens },
            decode: { samples, prefix in
                decodedInputs.append(samples)
                return ("transcribed prefill", prefix)
            },
            shouldContinue: { true }
        )

        XCTAssertEqual(text, "transcribed prefill")
        XCTAssertFalse(decodedInputs.isEmpty)
        XCTAssertEqual(decodedInputs.last?.count, totalSamples)
    }
}
