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
        XCTAssertGreaterThanOrEqual(first.boostedRMS, first.rawRMS * 4.0)
        XCTAssertLessThanOrEqual(gain.currentGain, SpeechGain.maxGain)
        XCTAssertTrue(first.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 })

        let second = gain.process(quiet)
        XCTAssertGreaterThanOrEqual(second.boostedRMS, 0.015)
        XCTAssertTrue(second.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 })

        var inbox = SpeechInbox()
        _ = try inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        let scheduled = try inbox.offer(quiet)
        XCTAssertTrue(scheduled)
        XCTAssertTrue(inbox.lastVoiced)
        let level = inbox.pollAudioLevel(now: 0.1)
        XCTAssertNotNil(level)
        XCTAssertGreaterThan(level ?? 0, 0.015)

        let batch = inbox.take()
        XCTAssertNotNil(batch)
        XCTAssertTrue(batch?.speech == true)
        XCTAssertEqual(batch?.trailingSilence, 0)
        XCTAssertTrue(batch?.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 } == true)
    }

    func testLoudInputAndPlosivesStayBoundedWithoutHardClipping() {
        var gain = SpeechGain()
        // First prime gain high on quiet speech, then hit a sudden loud transient.
        _ = gain.process(sineWave(count: 1600, rms: 0.002))
        let loud = sineWave(count: 1600, rms: 0.85)
        let result = gain.process(loud)

        XCTAssertTrue(result.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 })
        XCTAssertLessThanOrEqual(gain.currentGain, 1.5)
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

        // Modulated quiet speech (RMS 0.003..0.0055) over the learned 0.0015 floor opens VAD & amplifies safely.
        for (idx, rms) in [Float(0.0040), 0.0055, 0.0032, 0.0050, 0.0035].enumerated() {
            let speechChunk = sineWave(count: 400, rms: rms, freqHz: 240, phaseOffset: idx * 400)
            _ = try coldInbox.offer(speechChunk)
            XCTAssertTrue(coldInbox.lastVoiced)
            let batch = coldInbox.take()
            XCTAssertTrue(batch?.speech == true)
            XCTAssertGreaterThanOrEqual(SpeechGain.rms(batch?.samples ?? []), rms * 3.0)
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
}
