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

    func testRawPcmStartControllerRetainsCallAcrossOwnershipTakeAndPreventsDoubleSettle() {
        final class FakeCapCall {
            var resolveCount = 0
            var rejectMessages: [String] = []
            func resolve() { resolveCount += 1 }
            func reject(_ msg: String) { rejectMessages.append(msg) }
        }

        let controller = RawPcmStartController<FakeCapCall>()
        var settledCall: FakeCapCall? = {
            var externalCall: FakeCapCall? = FakeCapCall()
            weak var weakRef = externalCall
            let (token, superseded) = controller.beginStart(externalCall!)
            XCTAssertNil(superseded)
            XCTAssertTrue(controller.hasPendingStart)
            XCTAssertTrue(controller.isExpected(token: token))

            // Drop the caller's local ref just like Capacitor returning from @objc startRawPcmCapture.
            externalCall = nil
            XCTAssertNotNil(weakRef)

            // Consuming ownership clears internal state first, yet strong return value keeps call alive.
            let taken = controller.takePendingIfCurrent(token: token)
            XCTAssertFalse(controller.hasPendingStart)
            XCTAssertFalse(controller.isExpected(token: token))
            XCTAssertNotNil(taken)
            XCTAssertNotNil(weakRef)

            // Duplicate settle attempt must return nil.
            XCTAssertNil(controller.takePendingIfCurrent(token: token))
            XCTAssertNil(controller.invalidateAndTakePending())
            taken?.resolve()
            return taken
        }()

        XCTAssertEqual(settledCall?.resolveCount, 1)
        XCTAssertEqual(settledCall?.rejectMessages, [])
        settledCall = nil
    }

    func testRawPcmStartControllerInvalidatesInFlightStartOnConcurrentStopOrSupersede() {
        final class FakeCapCall {
            var resolved = 0
            var rejected: [String] = []
        }

        let controller = RawPcmStartController<FakeCapCall>()
        let call1 = FakeCapCall()
        let (token1, sup1) = controller.beginStart(call1)
        XCTAssertNil(sup1)

        // Concurrent stop invalidates token1 synchronously before audioQueue installs tap.
        let cancelled = controller.invalidateAndTakePending()
        XCTAssertTrue(cancelled === call1)
        cancelled?.rejected.append("Raw PCM capture stopped before ready")
        XCTAssertFalse(controller.isExpected(token: token1))
        XCTAssertNil(controller.takePendingIfCurrent(token: token1))

        // Superseding an active pending start returns prior call once and invalidates its token.
        let call2 = FakeCapCall()
        let (token2, sup2) = controller.beginStart(call2)
        XCTAssertNil(sup2)
        let call3 = FakeCapCall()
        let (token3, sup3) = controller.beginStart(call3)
        XCTAssertTrue(sup3 === call2)
        XCTAssertFalse(controller.isExpected(token: token2))
        XCTAssertTrue(controller.isExpected(token: token3))
        XCTAssertNil(controller.takePendingIfCurrent(token: token2))
        XCTAssertTrue(controller.takePendingIfCurrent(token: token3) === call3)
    }

    func testExpiredRawPcmSuccessOrErrorCannotReleaseNewerTapOrPhoneCaptureOccupancy() {
        final class FakeCapCall {
            var resolved = 0
            var rejected: [String] = []
        }

        let controller = RawPcmStartController<FakeCapCall>()

        // Round-trip race: start(A) installs tap A on audioQueue and queues completion to main.
        // Before A's main completion runs: stop(A) invalidates A, then start(B) begins on main
        // and runs on audioQueue after stop(A), installing tap B (ownerB) with rawPcmActiveOwner = ownerB.
        let callA = FakeCapCall()
        let (tokenA, _) = controller.beginStart(callA)
        let ownerA: UInt64 = 1

        var activeRawPcmTapOwner: UInt64? = ownerA
        var activeAsrTapOwner: UInt64? = nil
        var rawPcmActiveOwner: UInt64 = ownerA
        var phoneCaptureActive = true

        // stop(A) runs on main then audioQueue.
        let cancelledA = controller.invalidateAndTakePending()
        XCTAssertTrue(cancelledA === callA)
        cancelledA?.rejected.append("Raw PCM capture stopped before ready")
        rawPcmActiveOwner = 0
        activeRawPcmTapOwner = nil

        // start(B) runs on main then audioQueue, installing tap B (raw PCM, so activeAsrTapOwner == nil).
        let callB = FakeCapCall()
        let (tokenB, _) = controller.beginStart(callB)
        let ownerB: UInt64 = 2
        rawPcmActiveOwner = ownerB
        activeRawPcmTapOwner = ownerB
        phoneCaptureActive = true

        // 1) Expired main success callback for A runs: takePendingIfCurrent(tokenA) returns nil,
        // so A MUST NOT clear B's rawPcmActiveOwner or enqueue audioQueue teardown against B's tap.
        XCTAssertNil(controller.takePendingIfCurrent(token: tokenA))
        XCTAssertFalse(
            RawPcmCaptureLifecyclePolicy.shouldRollbackTapOnAudioQueue(
                expectedOwner: ownerA,
                activeRawPcmTapOwner: activeRawPcmTapOwner,
                activeAsrTapOwner: activeAsrTapOwner
            )
        )
        XCTAssertEqual(rawPcmActiveOwner, ownerB)
        XCTAssertEqual(activeRawPcmTapOwner, ownerB)
        XCTAssertTrue(phoneCaptureActive)
        XCTAssertTrue(controller.isExpected(token: tokenB))

        // B settles normally on main.
        let settledB = controller.takePendingIfCurrent(token: tokenB)
        settledB?.resolved += 1
        XCTAssertEqual(callB.resolved, 1)

        // 2) Expired error callback for A (e.g., permission/engine error) arriving after stop(A)+start(C)
        // while C is still starting on audioQueue (rawPcmActiveOwner == 0, activeMainOwner == 0):
        // A cannot consume C's pending token, so A MUST NOT release SharedSpeechRecognizerStore phoneCaptureActive.
        let callExpired = FakeCapCall()
        let (tokenExpired, _) = controller.beginStart(callExpired)
        _ = controller.invalidateAndTakePending()
        let callC = FakeCapCall()
        let (tokenC, _) = controller.beginStart(callC)
        rawPcmActiveOwner = 0
        let consumedExpired = controller.takePendingIfCurrent(token: tokenExpired)
        XCTAssertNil(consumedExpired)
        XCTAssertFalse(
            RawPcmCaptureLifecyclePolicy.shouldReleasePhoneCaptureOnError(
                consumedPendingStart: consumedExpired != nil,
                activeMainOwner: 0,
                isRawPcmCaptureActive: rawPcmActiveOwner != 0,
                hasPendingRawPcmStart: controller.hasPendingStart
            )
        )
        // Whereas if C itself fails and consumes tokenC with no other owners active, occupancy releases cleanly.
        let consumedC = controller.takePendingIfCurrent(token: tokenC)
        XCTAssertTrue(consumedC === callC)
        XCTAssertTrue(
            RawPcmCaptureLifecyclePolicy.shouldReleasePhoneCaptureOnError(
                consumedPendingStart: consumedC != nil,
                activeMainOwner: 0,
                isRawPcmCaptureActive: rawPcmActiveOwner != 0,
                hasPendingRawPcmStart: controller.hasPendingStart
            )
        )
        _ = activeAsrTapOwner
    }
}
