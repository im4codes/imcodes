/**
 * Fields a queued transport entry projects onto the `user.message` row that is
 * written when it is finally delivered (resend drain, runtime drain, active-turn
 * append). Every such path uses this one projection, so attribution written at
 * send time (share actor, alias audit anchor, message origin) cannot be dropped
 * by one of them and make a daemon or agent message render as the human's.
 */
import { USER_MESSAGE_ORIGIN_FIELDS, type ChatMessageOrigin } from '../../shared/chat-message-origin.js';
import type { AliasSendAudit } from '../../shared/alias-types.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';

export interface QueuedUserMessageAttribution {
  sharedActor?: SharedActorEnvelope;
  aliasAudit?: AliasSendAudit;
  messageOrigin?: ChatMessageOrigin;
}

export function queuedUserMessageAttribution(entry: QueuedUserMessageAttribution): Record<string, unknown> {
  return {
    ...(entry.sharedActor ? { sharedActor: entry.sharedActor } : {}),
    ...(entry.aliasAudit ? { aliasAudit: entry.aliasAudit } : {}),
    ...(entry.messageOrigin ? { [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: entry.messageOrigin } : {}),
  };
}
