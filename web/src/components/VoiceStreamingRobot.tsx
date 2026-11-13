export interface VoiceStreamingRobotProps {
  active?: boolean;
}

/**
 * Inline animated sci-fi mini-robot cursor displayed right after the last recognized
 * character during live speech streaming. Uses pure SVG + CSS with zero text nodes
 * so `.textContent` of parent transcript elements stays exact.
 */
export function VoiceStreamingRobot({ active = true }: VoiceStreamingRobotProps) {
  return (
    <span
      class={`voice-streaming-robot-cursor${active ? ' is-active' : ''}`}
      aria-hidden="true"
    >
      <svg
        class="voice-streaming-robot-svg"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
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
