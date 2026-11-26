import XCTest
@testable import StreamingSpeechPlugin

final class TtsBackgroundLifecycleTests: XCTestCase {
    func testWillResignActiveAndDidEnterBackgroundPreserveActiveTtsWithoutDeactivatingOrWarmHold() {
        for event in [TtsLifecycleEvent.willResignActive, .didEnterBackground] {
            let ttsOnly = TtsBackgroundLifecyclePolicy.decide(
                event: event,
                isTtsActive: true,
                hasActiveCapture: false
            )
            XCTAssertEqual(
                ttsOnly,
                TtsLifecycleDecision(
                    shouldStopCapture: false,
                    shouldStopTts: false,
                    shouldDeactivateAudioSession: false,
                    shouldScheduleWarmHold: false
                )
            )

            let ttsWithSttRace = TtsBackgroundLifecyclePolicy.decide(
                event: event,
                isTtsActive: true,
                hasActiveCapture: true
            )
            XCTAssertEqual(
                ttsWithSttRace,
                TtsLifecycleDecision(
                    shouldStopCapture: true,
                    shouldStopTts: false,
                    shouldDeactivateAudioSession: false,
                    shouldScheduleWarmHold: false
                )
            )
        }
    }

    func testWillResignActiveAndDidEnterBackgroundStopCaptureAndDeactivateWhenTtsInactive() {
        for event in [TtsLifecycleEvent.willResignActive, .didEnterBackground] {
            for hasCapture in [false, true] {
                let decision = TtsBackgroundLifecyclePolicy.decide(
                    event: event,
                    isTtsActive: false,
                    hasActiveCapture: hasCapture
                )
                XCTAssertEqual(
                    decision,
                    TtsLifecycleDecision(
                        shouldStopCapture: true,
                        shouldStopTts: false,
                        shouldDeactivateAudioSession: true,
                        shouldScheduleWarmHold: false
                    )
                )
            }
        }
    }

    func testAudioSessionInterruptionBeganStopsCaptureAndTtsAndDeactivatesSession() {
        let withTts = TtsBackgroundLifecyclePolicy.decide(
            event: .audioSessionInterruptionBegan,
            isTtsActive: true,
            hasActiveCapture: false
        )
        XCTAssertEqual(
            withTts,
            TtsLifecycleDecision(
                shouldStopCapture: true,
                shouldStopTts: true,
                shouldDeactivateAudioSession: true,
                shouldScheduleWarmHold: false
            )
        )

        let ended = TtsBackgroundLifecyclePolicy.decide(
            event: .audioSessionInterruptionEnded,
            isTtsActive: true,
            hasActiveCapture: false
        )
        XCTAssertEqual(
            ended,
            TtsLifecycleDecision(
                shouldStopCapture: false,
                shouldStopTts: false,
                shouldDeactivateAudioSession: false,
                shouldScheduleWarmHold: false
            )
        )
    }
}
