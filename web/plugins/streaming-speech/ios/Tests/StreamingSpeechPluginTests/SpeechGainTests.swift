import XCTest
@testable import StreamingSpeechPlugin

final class SpeechGainTests: XCTestCase {
    private func sineWave(count: Int, rms: Float, freqHz: Float = 220, sampleRate: Float = 16000) -> [Float] {
        let peak = rms * sqrt(2.0)
        return (0..<count).map { i in
            peak * sin(2.0 * .pi * freqHz * Float(i) / sampleRate)
        }
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
}
