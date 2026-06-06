import type { DbDiscussionComment } from '../db/queries.js';
import type { ShareAuthorizationSnapshot, SharedActorEnvelope } from '../../../shared/tab-sharing.js';

function parseJsonField<T>(value: T | string | null | undefined): T | null {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export type DiscussionCommentView = DbDiscussionComment & {
  actorEnvelope: SharedActorEnvelope | null;
  authorizationSnapshot: ShareAuthorizationSnapshot | null;
  coveringShareIds: string[];
  createdByUserId: string;
  createdAt: number;
};

export function toDiscussionCommentView(comment: DbDiscussionComment): DiscussionCommentView {
  return {
    ...comment,
    actorEnvelope: parseJsonField<SharedActorEnvelope>(comment.actor_envelope),
    authorizationSnapshot: parseJsonField<ShareAuthorizationSnapshot>(comment.authorization_snapshot),
    coveringShareIds: parseJsonField<string[]>(comment.covering_share_ids) ?? [],
    createdByUserId: comment.created_by_user_id,
    createdAt: comment.created_at,
  };
}
