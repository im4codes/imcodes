// Generic server→browser pub/sub for cache invalidation.
//
// Instead of building a bespoke WS push per feature (or polling over HTTP), the
// server emits a single `resource.changed` message tagged with a `topic`. Any
// browser view that cares about that topic subscribes (web: `useResourceEvent`)
// and refetches over HTTP when it fires. The server publishes via
// `WsBridge.publishResourceChanged(serverId, topic)`. Cron is just the first
// consumer — add new topics here as other modules adopt it.

export const RESOURCE_EVENT_MSG = {
  CHANGED: 'resource.changed',
} as const;

export const RESOURCE_TOPICS = {
  cron: 'cron',
} as const;

export type ResourceTopic = typeof RESOURCE_TOPICS[keyof typeof RESOURCE_TOPICS];

export interface ResourceChangedMessage {
  type: typeof RESOURCE_EVENT_MSG.CHANGED;
  topic: ResourceTopic;
  serverId: string;
  /** Optional hint about what happened: e.g. 'create' | 'update' | 'delete'. */
  action?: string;
}
