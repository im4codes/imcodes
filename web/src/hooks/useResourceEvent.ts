import { useEffect, useRef } from 'preact/hooks';
import { RESOURCE_EVENT_MSG } from '@shared/resource-events.js';
import type { ResourceTopic } from '@shared/resource-events.js';
import type { WsClient } from '../ws-client.js';

/**
 * Subscribe to server-pushed `resource.changed` events for a single topic and
 * run `onChange` (typically an HTTP refetch) when one arrives. Generic — any
 * view can use it instead of polling. Re-subscribes only when `ws`/`topic`
 * change; `onChange` is read through a ref so an unstable callback is fine.
 */
export function useResourceEvent(
  ws: WsClient | null | undefined,
  topic: ResourceTopic,
  onChange: () => void,
): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!ws) return undefined;
    return ws.onMessage((msg) => {
      if (msg.type === RESOURCE_EVENT_MSG.CHANGED && msg.topic === topic) {
        onChangeRef.current();
      }
    });
  }, [ws, topic]);
}
