const NOISE_FLOOR_LEVEL = 0.004;
const PERCEPTUAL_EXPONENT = 0.38;

/**
 * Normalize raw microphone RMS / capture levels onto a perceptually responsive [0..1] scale
 * so quiet-to-normal mobile speech (0.015-0.08 raw RMS) visibly animates waveform bars
 * while silence / ambient noise floor (<= 0.004) stays flat at 0.
 */
export function normalizeVoiceWaveformLevel(rawLevel: number): number {
  if (!Number.isFinite(rawLevel) || rawLevel <= NOISE_FLOOR_LEVEL) return 0;
  const clamped = Math.min(1, rawLevel);
  const scaled = (clamped - NOISE_FLOOR_LEVEL) / (1 - NOISE_FLOOR_LEVEL);
  return Math.min(1, Math.pow(scaled, PERCEPTUAL_EXPONENT));
}
