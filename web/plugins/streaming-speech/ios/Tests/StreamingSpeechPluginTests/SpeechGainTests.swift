import XCTest
@testable import StreamingSpeechPlugin

final class SpeechGainTests: XCTestCase {
    private func sineWave(count: Int, rms: Float, freqHz: Float = 220, sampleRate: Float = 16000, phaseOffset: Int = 0) -> [Float] {
        let peak = rms * sqrt(2.0)
        return (0..<count).map { i in
            peak * sin(2.0 * .pi * freqHz * Float(phaseOffset + i) / sampleRate)
        }
    }

    private func broadbandNoise(count: Int, rms: Float, seed: UInt64 = 0x9E37_79B9_7F4A_7C15) -> [Float] {
        var state = seed
        var raw = [Float](repeating: 0, count: count)
        var sumSq: Double = 0
        for i in 0..<count {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            let u = Float(Int32(bitPattern: UInt32(truncatingIfNeeded: state >> 32))) / Float(Int32.max)
            raw[i] = u
            sumSq += Double(u) * Double(u)
        }
        let actualRMS = Float(sqrt(sumSq / Double(max(1, count))))
        let scale = actualRMS > 0 ? rms / actualRMS : 0
        return raw.map { $0 * scale }
    }

    func testQuietSpeechIsAmplifiedSafelyAndTriggersVAD() throws {
        var gain = SpeechGain()
        let quiet = sineWave(count: 1600, rms: 0.0025)
        let first = gain.process(quiet)
        XCTAssertEqual(first.boostedRMS, first.rawRMS, accuracy: 1e-5)
        XCTAssertEqual(gain.currentGain, 1.0, accuracy: 1e-6)
        XCTAssertTrue(first.anyVoiced)
        XCTAssertTrue(first.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 })

        let second = gain.process(quiet)
        XCTAssertEqual(second.boostedRMS, second.rawRMS, accuracy: 1e-5)
        XCTAssertTrue(second.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 })

        var inbox = SpeechInbox()
        _ = try inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        let scheduled = try inbox.offer(quiet)
        XCTAssertTrue(scheduled)
        XCTAssertTrue(inbox.lastVoiced)
        let level = inbox.pollAudioLevel(now: 0.1)
        XCTAssertNotNil(level)
        XCTAssertEqual(level ?? 0, 0.0025, accuracy: 2e-4)

        let batch = inbox.take()
        XCTAssertNotNil(batch)
        XCTAssertTrue(batch?.speech == true)
        XCTAssertEqual(batch?.trailingSilence, 0)
        XCTAssertTrue(batch?.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 } == true)
    }

    func testLoudInputAndPlosivesStayBoundedWithoutHardClipping() {
        var gain = SpeechGain()
        _ = gain.process(sineWave(count: 1600, rms: 0.002))
        let loud = sineWave(count: 1600, rms: 0.85)
        let result = gain.process(loud)

        XCTAssertTrue(result.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 })
        XCTAssertEqual(gain.currentGain, 1.0, accuracy: 1e-6)
    }

    func testSilenceAndUltraLowNoiseFloorStayUnboostedAndUnvoiced() throws {
        var gain = SpeechGain()
        let silence = [Float](repeating: 0, count: 1600)
        let silenceOut = gain.process(silence)
        XCTAssertEqual(silenceOut.boostedRMS, 0, accuracy: 1e-6)
        XCTAssertEqual(gain.currentGain, 1.0, accuracy: 1e-6)

        let noise = sineWave(count: 1600, rms: 0.0003)
        let noiseOut = gain.process(noise)
        XCTAssertLessThanOrEqual(noiseOut.boostedRMS, noiseOut.rawRMS * 1.05)

        var inbox = SpeechInbox()
        _ = try inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        _ = try inbox.offer(noise)
        XCTAssertFalse(inbox.lastVoiced)
        let noiseBatch = inbox.take()
        XCTAssertEqual(noiseBatch?.speech, false)
        XCTAssertEqual(noiseBatch?.trailingSilence, noise.count)

        // Quiet speech followed by ambient floor must release voiced to false so VAD pause commits.
        _ = try inbox.offer(sineWave(count: 1600, rms: 0.003))
        XCTAssertTrue(inbox.lastVoiced)
        _ = inbox.take()

        _ = try inbox.offer(sineWave(count: 1600, rms: 0.0004))
        XCTAssertFalse(inbox.lastVoiced)
        let releaseBatch = inbox.take()
        XCTAssertEqual(releaseBatch?.trailingSilence, 1600)
    }

    func testSteadyHumAndFanNoiseAdaptAndCommitVADPauseAcrossChunkSizes() throws {
        // Test 60Hz hum (0.0012, 0.002, 0.003) and broadband fan noise (0.002) across 25ms, 100ms, and 1.2s chunks.
        for chunkSize in [400, 1600, 19200] {
            for (kind, rms) in [("hum60", Float(0.002)), ("hum60_low", Float(0.0012)), ("hum60_high", Float(0.003)), ("fan", Float(0.002))] {
                var inbox = SpeechInbox()
                var window = SpeechWindow()
                var decodeCount = 0
                let decode: SpeechWindow.DecodeFn = { _, _ in
                    decodeCount += 1
                    return ("speech", [10, 11])
                }

                _ = try inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
                // 0.2s quiet speech at RMS 0.005 opens segment.
                for step in 0..<8 {
                    _ = try inbox.offer(sineWave(count: 400, rms: 0.005, freqHz: 220, phaseOffset: step * 400))
                    if let batch = inbox.take() {
                        try window.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: decode) { _ in }
                    }
                }
                XCTAssertTrue(!window.samples.isEmpty)

                // Followed by 1.2s (19,200 samples) continuous steady noise.
                let totalNoise = 19200
                var offset = 0
                while offset < totalNoise {
                    let count = min(chunkSize, totalNoise - offset)
                    let chunk = kind == "fan"
                        ? broadbandNoise(count: count, rms: rms, seed: UInt64(0x55AA_0001 + offset))
                        : sineWave(count: count, rms: rms, freqHz: 60, phaseOffset: offset)
                    _ = try inbox.offer(chunk)
                    if let batch = inbox.take() {
                        try window.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: decode) { _ in }
                    }
                    offset += count
                }

                XCTAssertFalse(inbox.lastVoiced)
                XCTAssertTrue(window.samples.isEmpty)
                XCTAssertEqual(window.committed, "speech")
                XCTAssertGreaterThan(decodeCount, 0)
            }
        }

        // Cold-start steady noise adapts cleanly, and modulated quiet speech above noise still opens & boosts.
        var coldInbox = SpeechInbox()
        _ = try coldInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        for step in 0..<48 {
            _ = try coldInbox.offer(broadbandNoise(count: 400, rms: 0.0015, seed: UInt64(0x100 + step)))
            _ = coldInbox.take()
        }
        XCTAssertFalse(coldInbox.lastVoiced)

        // Modulated quiet speech (RMS 0.003..0.0055) over the learned 0.0015 floor opens VAD cleanly without gain boost.
        for (idx, rms) in [Float(0.0040), 0.0055, 0.0032, 0.0050, 0.0035].enumerated() {
            let speechChunk = sineWave(count: 400, rms: rms, freqHz: 240, phaseOffset: idx * 400)
            _ = try coldInbox.offer(speechChunk)
            XCTAssertTrue(coldInbox.lastVoiced)
            let batch = coldInbox.take()
            XCTAssertTrue(batch?.speech == true)
            XCTAssertEqual(SpeechGain.rms(batch?.samples ?? []), rms, accuracy: 2e-4)
            XCTAssertTrue(batch?.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 } == true)
        }
    }

    func testSustainedAndSlowlyVaryingQuietSpeechAreNotSwallowedAsNoise() throws {
        // Counterexample 1: 2.0s (80 x 400-sample frames) of steady quiet speech (RMS 0.0025, 220Hz)
        // must stay voiced well past the noise learning window without premature SpeechWindow pause commit.
        do {
            var inbox = SpeechInbox()
            var window = SpeechWindow()
            var maxDecodedSamples = 0
            let decode: SpeechWindow.DecodeFn = { s, _ in
                maxDecodedSamples = max(maxDecodedSamples, s.count)
                return ("sustained", [1, 2])
            }
            _ = try inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
            var voicedCount = 0
            for step in 0..<80 {
                let chunk = sineWave(count: 400, rms: 0.0025, freqHz: 220, phaseOffset: step * 400)
                _ = try inbox.offer(chunk)
                if inbox.lastVoiced { voicedCount += 1 }
                if let batch = inbox.take() {
                    try window.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: decode) { _ in }
                }
            }
            XCTAssertEqual(voicedCount, 80)
            XCTAssertTrue(inbox.lastVoiced)
            XCTAssertEqual(window.samples.count, 32000)
            XCTAssertTrue(window.committed.isEmpty)
            XCTAssertGreaterThanOrEqual(maxDecodedSamples, 24000)
        }

        // Counterexample 2: 2.0s of slowly amplitude-modulated multi-harmonic quiet speech strictly below 0.0040
        // (RMS smoothly oscillating 0.0014..0.0036) must keep all 80 frames voiced and retain the trailing second.
        do {
            var inbox = SpeechInbox()
            var window = SpeechWindow()
            var maxDecodedSamples = 0
            let decode: SpeechWindow.DecodeFn = { s, _ in
                maxDecodedSamples = max(maxDecodedSamples, s.count)
                return ("harmonic", [3, 4])
            }
            _ = try inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
            var voicedCount = 0
            for step in 0..<80 {
                let targetRMS: Float = 0.0025 + 0.0011 * sin(2.0 * .pi * Float(step) / 40.0) // 0.0014 .. 0.0036
                var raw = [Float](repeating: 0, count: 400)
                var sumSq: Double = 0
                for i in 0..<400 {
                    let t = Float(step * 400 + i) / 16000.0
                    let v = 0.45 * sin(2.0 * .pi * 145.0 * t)
                        + 0.35 * sin(2.0 * .pi * 290.0 * t)
                        + 0.25 * sin(2.0 * .pi * 580.0 * t)
                        + 0.15 * sin(2.0 * .pi * 1160.0 * t)
                    raw[i] = v
                    sumSq += Double(v) * Double(v)
                }
                let actualRMS = Float(sqrt(sumSq / 400.0))
                let scale = targetRMS / actualRMS
                _ = try inbox.offer(raw.map { $0 * scale })
                if inbox.lastVoiced { voicedCount += 1 }
                if let batch = inbox.take() {
                    try window.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: decode) { _ in }
                }
            }
            XCTAssertEqual(voicedCount, 80)
            XCTAssertTrue(inbox.lastVoiced)
            XCTAssertEqual(window.samples.count, 32000)
            XCTAssertTrue(window.committed.isEmpty)
            XCTAssertGreaterThanOrEqual(maxDecodedSamples, 24000)
        }
    }

    func testCoordinatorEmitsStartedImmediatelyBeforeTapWhileStillDroppingWarmupSamples() {
        let emitQueue = DispatchQueue(label: "test.coordinator.emit")
        let readyExp = expectation(description: "onStartReady settled immediately")
        let startedExp = expectation(description: "started event emitted immediately")
        let stoppedExp = expectation(description: "stopped event emitted cleanly")

        let lock = NSLock()
        var events: [SpeechCoordinator.Event] = []
        var readyCount = 0
        var decodedSampleCounts: [Int] = []

        let coordinator = SpeechCoordinator(emitQueue: emitQueue) { event in
            lock.lock()
            events.append(event)
            lock.unlock()
            if event == .started {
                startedExp.fulfill()
            } else if event == .stopped {
                stoppedExp.fulfill()
            }
        }

        let owner = coordinator.beginStart(
            makeDecode: {
                SpeechCoordinator.Decoder(
                    decode: { samples, _, _ in
                        lock.lock()
                        decodedSampleCounts.append(samples.count)
                        lock.unlock()
                        return ("hello", [1, 2])
                    },
                    rollbackPrefix: { tokens, _ in tokens }
                )
            },
            onStartReady: {
                lock.lock()
                readyCount += 1
                lock.unlock()
                readyExp.fulfill()
            },
            onSetupFailureTeardown: {
                XCTFail("Unexpected setup failure")
            }
        )

        coordinator.markStarted(owner: owner)
        wait(for: [readyExp, startedExp], timeout: 2.0)

        // Warmup samples (320 samples = 20ms) are still discarded before audioLevel / decode.
        coordinator.offerSamples(
            [Float](repeating: 0.5, count: SpeechInbox.warmupSamples),
            owner: owner,
            now: 1.0,
            onOverloadTeardown: { XCTFail("Unexpected overload") }
        )
        emitQueue.sync {}
        coordinator.worker.sync {}
        lock.lock()
        let warmupAudioLevels = events.filter {
            if case .audioLevel = $0 { return true }
            return false
        }.count
        let warmupDecodedCount = decodedSampleCounts.count
        lock.unlock()
        XCTAssertEqual(warmupAudioLevels, 0, "Warmup samples must not emit audioLevel")
        XCTAssertEqual(warmupDecodedCount, 0, "Warmup samples must not reach decoder")

        coordinator.offerSamples(
            sineWave(count: 400, rms: 0.05),
            owner: owner,
            now: 2.0,
            onOverloadTeardown: { XCTFail("Unexpected overload") }
        )
        emitQueue.sync {}

        let stopAckExp = expectation(description: "stop completion resolved")
        coordinator.endCapture(
            stopCompletion: { err in
                XCTAssertNil(err)
                stopAckExp.fulfill()
            },
            stopAudio: {}
        )
        wait(for: [stoppedExp, stopAckExp], timeout: 2.0)

        lock.lock()
        let startedCount = events.filter { $0 == .started }.count
        let audioLevelCount = events.filter {
            if case .audioLevel = $0 { return true }
            return false
        }.count
        let finalReadyCount = readyCount
        let finalDecodedCounts = decodedSampleCounts
        lock.unlock()

        XCTAssertEqual(finalReadyCount, 1)
        XCTAssertEqual(startedCount, 1)
        XCTAssertEqual(audioLevelCount, 1, "Only post-warmup audio should emit audioLevel")
        XCTAssertEqual(finalDecodedCounts, [400 + SpeechWindow.finalSilencePadding], "Only post-warmup samples + finalSilencePadding should reach decoder")
    }

    func testRequestRecordPermissionRunsOffMainOnAudioQueueAndResolvesOnMain() {
        let plugin = StreamingSpeechPlugin()
        let requesterExp = expectation(description: "requester runs on serial audioQueue off main")
        let completionExp = expectation(description: "completion resolves back on main")

        var requesterOnMain = true
        var requesterOnAudioQueue = false
        var completionOnMain = false
        var grantedResult = false

        plugin.requestRecordPermission(
            requester: { finish in
                requesterOnMain = Thread.isMainThread
                requesterOnAudioQueue = plugin.isOnAudioQueueForTesting
                requesterExp.fulfill()
                DispatchQueue.global(qos: .utility).async {
                    finish(true)
                }
            },
            completion: { allowed in
                completionOnMain = Thread.isMainThread
                grantedResult = allowed
                completionExp.fulfill()
            }
        )

        wait(for: [requesterExp, completionExp], timeout: 2.0)
        XCTAssertFalse(requesterOnMain)
        XCTAssertTrue(requesterOnAudioQueue)
        XCTAssertTrue(completionOnMain)
        XCTAssertTrue(grantedResult)
    }

    func testIphone16SilenceProfileAndPreOnsetGuardRejectsMicroBurstsWhileKeepingQuietSpeech() throws {
        var gain = SpeechGain()
        for _ in 0..<4 {
            let zeroOut = gain.process([Float](repeating: 0, count: 400))
            XCTAssertFalse(zeroOut.anyVoiced)
        }
        XCTAssertEqual(gain.noiseFloorRMS, SpeechGain.initialNoiseFloorRMS, accuracy: 1e-6,
                       "digital zeros must not drag noiseFloorRMS down")

        var inbox = SpeechInbox()
        var window = SpeechWindow()
        var decodeCalls = 0
        let decode: SpeechWindow.DecodeFn = { _, _ in
            decodeCalls += 1
            return ("嗯", [1])
        }
        _ = try inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        for frame in 0..<400 {
            let chunk: [Float]
            if frame < 3 {
                chunk = [Float](repeating: 0, count: 400)
            } else if frame == 11 || frame == 12 {
                // Brief 50ms codec settle pulse (< 150ms pre-onset confirmation)
                chunk = sineWave(count: 400, rms: 0.0014, freqHz: 240, phaseOffset: frame * 400)
            } else if frame == 184 || (frame >= 190 && frame <= 195) {
                // Unpitched ambient noise bursts up to 0.0042 RMS
                chunk = broadbandNoise(count: 400, rms: frame == 184 ? 0.0042 : 0.0021, seed: UInt64(0xCAFE_0000 + frame))
            } else {
                chunk = broadbandNoise(count: 400, rms: 0.00048, seed: UInt64(0xFACE_0000 + frame))
            }
            _ = try inbox.offer(chunk)
            if let batch = inbox.take() {
                try window.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: decode) { _ in }
            }
        }
        XCTAssertTrue(window.samples.isEmpty, "10s iPhone 16 room silence profile must never lock SpeechWindow open")
        XCTAssertEqual(decodeCalls, 0)
        let silenceResult = try window.finish(decode: decode)
        XCTAssertEqual(silenceResult, "")
        XCTAssertEqual(decodeCalls, 0)

        // Pre-decode energy guard rejects flat room noise while accepting genuine quiet speech.
        XCTAssertFalse(SpeechWindow.hasDecodableEnergy(in: broadbandNoise(count: 32000, rms: 0.0008)))
        var speechWithSilence = [Float](repeating: 0.0004, count: 32000)
        let wordTone = sineWave(count: 3200, rms: 0.0025, freqHz: 220)
        speechWithSilence.replaceSubrange(16000..<19200, with: wordTone)
        XCTAssertTrue(SpeechWindow.hasDecodableEnergy(in: speechWithSilence))

        // Genuine soft word (200ms @ 0.0025 RMS) opens window cleanly with zero lost samples.
        var speechInbox = SpeechInbox()
        var speechWindow = SpeechWindow()
        var decodedCounts: [Int] = []
        let speechDecode: SpeechWindow.DecodeFn = { s, _ in
            decodedCounts.append(s.count)
            return ("嗯", [42])
        }
        _ = try speechInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        for step in 0..<8 {
            _ = try speechInbox.offer(sineWave(count: 400, rms: 0.0025, freqHz: 220, phaseOffset: step * 400))
            if let batch = speechInbox.take() {
                try speechWindow.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: speechDecode) { _ in }
            }
        }
        XCTAssertEqual(speechWindow.samples.count, 3200)
        let spoken = try speechWindow.finish(decode: speechDecode)
        XCTAssertEqual(spoken, "嗯")
        XCTAssertEqual(decodedCounts, [3200 + SpeechWindow.finalSilencePadding])
    }

    func testCheckPermissionsMapsRecordPermissionWithoutPrompting() {
        XCTAssertEqual(StreamingSpeechPlugin.mapRecordPermissionStatus(.granted), "granted")
        XCTAssertEqual(StreamingSpeechPlugin.mapRecordPermissionStatus(.denied), "denied")
        XCTAssertEqual(StreamingSpeechPlugin.mapRecordPermissionStatus(.undetermined), "prompt")
    }

    func testRealIphone16ThirtyFourSecondAmbientSilenceAdaptsFloorAndEmitsZeroDecodes() throws {
        // Counterexample derived from KOCA's iPhone 16 Pro Max (UDID 236E587B-47E4-5C91-9213-4D3E2B4434AD)
        // real 34s PCM captures (p50=0.0022..0.0030 RMS, stationary 117/148/531 Hz ambient components giving
        // hpRatio ~0.76 and 25ms autocorrelation 0.45..0.67). Prior to fix, noiseFloorRMS froze at 0.00075 and
        // SpeechWindow stayed locked past 13.5s segmentCapacity on 19 decode calls.
        var inbox = SpeechInbox()
        var window = SpeechWindow()
        var decodeCalls = 0
        let decode: SpeechWindow.DecodeFn = { _, _ in
            decodeCalls += 1
            return ("嗯", [1])
        }
        _ = try inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        for step in 0..<340 {
            let off = step * 1600
            let h1 = sineWave(count: 1600, rms: 0.0016, freqHz: 117, phaseOffset: off)
            let h2 = sineWave(count: 1600, rms: 0.0014, freqHz: 148, phaseOffset: off)
            let h3 = sineWave(count: 1600, rms: 0.0012, freqHz: 531, phaseOffset: off)
            let n = broadbandNoise(count: 1600, rms: 0.0016, seed: UInt64(0x16_0000 + step))
            let chunk = (0..<1600).map { h1[$0] + h2[$0] + h3[$0] + n[$0] }
            _ = try inbox.offer(chunk)
            if let batch = inbox.take() {
                try window.append(
                    batch.samples,
                    speech: batch.speech,
                    trailingSilence: batch.trailingSilence,
                    activeSamples: batch.activeSamples,
                    noiseFloorRMS: batch.noiseFloorRMS,
                    decode: decode
                ) { _ in }
            }
        }
        let silenceOut = try window.finish(decode: decode)
        XCTAssertGreaterThanOrEqual(inbox.currentNoiseFloorRMS, 0.0020)
        XCTAssertTrue(window.samples.isEmpty)
        XCTAssertEqual(decodeCalls, 0)
        XCTAssertEqual(silenceOut, "")
        XCTAssertFalse(SpeechWindow.hasDecodableEnergy(in: broadbandNoise(count: 32000, rms: 0.0031), noiseFloorRMS: inbox.currentNoiseFloorRMS))

        // Quiet speech (~0.0055 RMS) over the adapted iPhone 16 floor still decodes completely.
        for step in 0..<4 {
            _ = try inbox.offer(sineWave(count: 1600, rms: 0.0055, freqHz: 220, phaseOffset: step * 1600))
            if let batch = inbox.take() {
                try window.append(
                    batch.samples,
                    speech: batch.speech,
                    trailingSilence: batch.trailingSilence,
                    activeSamples: batch.activeSamples,
                    noiseFloorRMS: batch.noiseFloorRMS,
                    decode: decode
                ) { _ in }
            }
        }
        let spoken = try window.finish(decode: decode)
        XCTAssertEqual(spoken, "嗯")
        XCTAssertEqual(decodeCalls, 1)

        // Elevated room floor (~0.0055 RMS, e.g. iPhone 16 room/AC noise above legacy 0.0048 ceiling)
        // must also adapt instead of freezing near 0.0006, producing 0 decodes across 20s while
        // soft speech (~0.012 RMS) above that floor still decodes.
        var elevInbox = SpeechInbox()
        var elevWindow = SpeechWindow()
        var elevDecodes = 0
        let elevDecode: SpeechWindow.DecodeFn = { _, _ in
            elevDecodes += 1
            return ("好", [2])
        }
        _ = try elevInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        for step in 0..<200 {
            let off = step * 1600
            let h1 = sineWave(count: 1600, rms: 0.0030, freqHz: 117, phaseOffset: off)
            let h2 = sineWave(count: 1600, rms: 0.0026, freqHz: 148, phaseOffset: off)
            let h3 = sineWave(count: 1600, rms: 0.0022, freqHz: 531, phaseOffset: off)
            let n = broadbandNoise(count: 1600, rms: 0.0030, seed: UInt64(0x16_5500 + step))
            let chunk = (0..<1600).map { h1[$0] + h2[$0] + h3[$0] + n[$0] }
            _ = try elevInbox.offer(chunk)
            if let batch = elevInbox.take() {
                try elevWindow.append(
                    batch.samples,
                    speech: batch.speech,
                    trailingSilence: batch.trailingSilence,
                    activeSamples: batch.activeSamples,
                    noiseFloorRMS: batch.noiseFloorRMS,
                    decode: elevDecode
                ) { _ in }
            }
        }
        XCTAssertGreaterThanOrEqual(elevInbox.currentNoiseFloorRMS, 0.0045)
        XCTAssertEqual(try elevWindow.finish(decode: elevDecode), "")
        XCTAssertEqual(elevDecodes, 0)

        for step in 0..<4 {
            _ = try elevInbox.offer(sineWave(count: 1600, rms: 0.012, freqHz: 220, phaseOffset: step * 1600))
            if let batch = elevInbox.take() {
                try elevWindow.append(
                    batch.samples,
                    speech: batch.speech,
                    trailingSilence: batch.trailingSilence,
                    activeSamples: batch.activeSamples,
                    noiseFloorRMS: batch.noiseFloorRMS,
                    decode: elevDecode
                ) { _ in }
            }
        }
        XCTAssertEqual(try elevWindow.finish(decode: elevDecode), "好")
        XCTAssertEqual(elevDecodes, 1)
    }
}
