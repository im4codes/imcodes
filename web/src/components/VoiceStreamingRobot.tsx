import type { JSX } from 'preact';

export const VOICE_ROBOT_LEVEL_THRESHOLD = 0.02;

const WAVE_BAR_SPECS = [
  { angle: 18, gain: 0.75, delayMs: 0 },
  { angle: 54, gain: 0.95, delayMs: 90 },
  { angle: 90, gain: 1.15, delayMs: 180 },
  { angle: 126, gain: 0.95, delayMs: 90 },
  { angle: 162, gain: 0.75, delayMs: 0 },
  { angle: 198, gain: 0.75, delayMs: 0 },
  { angle: 234, gain: 0.95, delayMs: 90 },
  { angle: 270, gain: 1.15, delayMs: 180 },
  { angle: 306, gain: 0.95, delayMs: 90 },
  { angle: 342, gain: 0.75, delayMs: 0 },
] as const;

export function clampVoiceRobotLevel(level?: number): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(1, level));
}

export function applyVoiceRobotLevel(el: HTMLElement | null, level: number): void {
  if (!el) return;
  const clamped = clampVoiceRobotLevel(level);
  el.style.setProperty('--voice-robot-level', clamped.toFixed(3));
  if (clamped > VOICE_ROBOT_LEVEL_THRESHOLD) {
    el.setAttribute('data-voice-level-active', 'true');
  } else {
    el.removeAttribute('data-voice-level-active');
  }
}

export function clearVoiceRobotLevel(el: HTMLElement | null): void {
  if (!el) return;
  el.style.removeProperty('--voice-robot-level');
  el.removeAttribute('data-voice-level-active');
}

export interface VoiceStreamingRobotProps {
  active?: boolean;
  level?: number;
}

/**
 * Inline animated sci-fi mini-robot cursor displayed right after the last recognized
 * character during live speech streaming. Uses pure SVG + CSS with zero text nodes
 * so `.textContent` of parent transcript elements stays exact.
 */
export function VoiceStreamingRobot({ active = true, level }: VoiceStreamingRobotProps) {
  const hasExplicitLevel = level !== undefined;
  const clampedLevel = clampVoiceRobotLevel(level);
  const hasLevel = hasExplicitLevel && clampedLevel > VOICE_ROBOT_LEVEL_THRESHOLD;

  return (
    <span
      class={`voice-streaming-robot-cursor${active ? ' is-active' : ''}${hasLevel ? ' has-level' : ''}`}
      style={hasExplicitLevel ? ({ '--voice-robot-level': clampedLevel.toFixed(3) } as JSX.CSSProperties) : undefined}
      aria-hidden="true"
    >
      <svg
        class="voice-streaming-robot-svg"
        viewBox="-5 -5 34 34"
        width="22"
        height="22"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <g class="voice-robot-wave-ring" aria-hidden="true">
          <circle
            class="voice-robot-wave-halo"
            cx="12"
            cy="12"
            r="13.2"
            stroke="rgba(56,189,248,0.45)"
            stroke-width="1.15"
          />
          {WAVE_BAR_SPECS.map(({ angle, gain, delayMs }) => (
            <g key={angle} transform={`rotate(${angle} 12 12)`}>
              <rect
                class="voice-robot-wave-bar"
                x="11.25"
                y="-3.6"
                width="1.5"
                height="4"
                rx="0.75"
                fill={angle === 90 || angle === 270 ? '#67e8f9' : '#a78bfa'}
                style={{
                  '--bar-gain': String(gain),
                  '--bar-delay': `${delayMs}ms`,
                } as JSX.CSSProperties}
              />
            </g>
          ))}
        </g>
        <circle class="voice-robot-aura" cx="12" cy="4" r="3" fill="rgba(34,211,238,0.28)" />
        <line x1="12" y1="7" x2="12" y2="4.8" stroke="#67e8f9" stroke-width="1.8" stroke-linecap="round" />
        <circle class="voice-robot-antenna" cx="12" cy="4" r="1.6" fill="#67e8f9" />
        <rect
          x="4.5"
          y="7"
          width="15"
          height="12"
          rx="4.2"
          fill="#0f172a"
          stroke="#38bdf8"
          stroke-width="1.7"
        />
        <line x1="3" y1="12.5" x2="4.5" y2="12.5" stroke="#38bdf8" stroke-width="1.7" stroke-linecap="round" />
        <line x1="19.5" y1="12.5" x2="21" y2="12.5" stroke="#38bdf8" stroke-width="1.7" stroke-linecap="round" />
        <circle class="voice-robot-eye" cx="9.2" cy="12.2" r="1.45" fill="#67e8f9" />
        <circle class="voice-robot-eye" cx="14.8" cy="12.2" r="1.45" fill="#67e8f9" />
        <path
          d="M9.4 15.6c.8.7 1.7 1 2.6 1s1.8-.3 2.6-1"
          stroke="#a78bfa"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    </span>
  );
}
