import { useEffect, useRef, useState } from 'preact/hooks';

const IDLE_FLASH_PLAYBACK_MS = 2700;

export function useIdleFlashPlayback(idleFlashToken?: number): number {
  const seenTokenRef = useRef(idleFlashToken ?? 0);
  const [playbackToken, setPlaybackToken] = useState(0);

  useEffect(() => {
    const nextToken = idleFlashToken ?? 0;
    if (nextToken > seenTokenRef.current) {
      seenTokenRef.current = nextToken;
      setPlaybackToken(nextToken);
    }
  }, [idleFlashToken]);

  useEffect(() => {
    if (!playbackToken) return;
    const clearId = window.setTimeout(() => {
      setPlaybackToken((current) => (current === playbackToken ? 0 : current));
    }, IDLE_FLASH_PLAYBACK_MS);
    return () => window.clearTimeout(clearId);
  }, [playbackToken]);

  return playbackToken;
}
