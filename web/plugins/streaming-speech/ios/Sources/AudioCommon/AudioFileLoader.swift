import Foundation
import AVFoundation

/// Sample-rate-conversion quality.
public enum ResampleQuality: Sendable, Equatable {
    case standard
    case mastering
}

/// Minimal audio resampling helper for offline Qwen3-ASR input normalization.
public enum AudioFileLoader {
    public static func resample(
        _ samples: [Float],
        from inputRate: Int,
        to outputRate: Int,
        quality: ResampleQuality = .standard
    ) -> [Float] {
        guard inputRate != outputRate, !samples.isEmpty else { return samples }

        guard let sourceFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: Double(inputRate),
                channels: 1, interleaved: false),
              let targetFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: Double(outputRate),
                channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: sourceFormat, to: targetFormat),
              let sourceBuffer = AVAudioPCMBuffer(
                pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(samples.count))
        else {
            return samples
        }

        configureSRC(converter, quality: quality)
        sourceBuffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in
            sourceBuffer.floatChannelData![0].update(from: src.baseAddress!, count: samples.count)
        }

        let ratio = Double(outputRate) / Double(inputRate)
        guard let out = convertDrained(
            converter: converter, source: sourceBuffer, targetFormat: targetFormat,
            inputFrames: samples.count, ratio: ratio, channels: 1)
        else {
            return samples
        }
        return out[0]
    }

    private static func configureSRC(_ converter: AVAudioConverter, quality: ResampleQuality) {
        switch quality {
        case .standard:
            break
        case .mastering:
            converter.sampleRateConverterAlgorithm = AVSampleRateConverterAlgorithm_Mastering
            converter.sampleRateConverterQuality = .max
        }
    }

    private static func convertDrained(
        converter: AVAudioConverter,
        source: AVAudioPCMBuffer,
        targetFormat: AVAudioFormat,
        inputFrames: Int,
        ratio: Double,
        channels: Int
    ) -> [[Float]]? {
        let capacity = AVAudioFrameCount(ceil(Double(inputFrames) * ratio)) + 4096
        guard let target = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            return nil
        }

        var out = [[Float]](repeating: [], count: channels)
        for c in 0..<channels { out[c].reserveCapacity(Int(capacity)) }

        var fed = false
        while true {
            target.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: target, error: &error) { _, outStatus in
                if fed {
                    outStatus.pointee = .endOfStream
                    return nil
                }
                fed = true
                outStatus.pointee = .haveData
                return source
            }

            let produced = Int(target.frameLength)
            if produced > 0, let chans = target.floatChannelData {
                for c in 0..<channels {
                    out[c].append(contentsOf: UnsafeBufferPointer(start: chans[c], count: produced))
                }
            }

            if status == .error || error != nil { return nil }
            if status == .endOfStream { break }
            if produced == 0 { return nil }
        }

        let expected = Int((Double(inputFrames) * ratio).rounded())
        guard expected > 0, !out[0].isEmpty else { return nil }
        for c in 0..<channels {
            if out[c].count > expected {
                out[c].removeLast(out[c].count - expected)
            } else if out[c].count < expected {
                out[c].append(contentsOf: repeatElement(0, count: expected - out[c].count))
            }
        }
        return out
    }
}
