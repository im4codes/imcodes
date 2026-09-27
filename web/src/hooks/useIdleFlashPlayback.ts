import { useEffect, useRef, useState } from 'preact/hooks';

const IDLE_FLASH_PLAYBACK_MS = 2700;

export function useIdleFlashPlayback(idleFlashToken?: number, enabled = true): number {
  const seenTokenRef = useRef(idleFlashToken ?? 0);
  const [playbackToken, setPlaybackToken] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const nextToken = idleFlashToken ?? 0;
    if (nextToken > seenTokenRef.current) {
      seenTokenRef.current = nextToken;
      setPlaybackToken(nextToken);
    }
  }, [enabled, idleFlashToken]);

  useEffect(() => {
    if (!enabled || !playbackToken) return;
    const clearId = window.setTimeout(() => {
      setPlaybackToken((current) => (current === playbackToken ? 0 : current));
    }, IDLE_FLASH_PLAYBACK_MS);
    return () => window.clearTimeout(clearId);
  }, [enabled, playbackToken]);

  return enabled ? playbackToken : 0;
}
