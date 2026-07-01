import { describe, expect, it } from 'vitest';

import {
  buildQueueProjectionEntry,
  buildQueueSharedActorProjection,
  containsProhibitedQueueProjectionField,
} from '../../shared/transport-queue-privacy.js';
import type { QueueStoredEntry } from '../../shared/transport-queue-types.js';

function storedEntry(input: Partial<QueueStoredEntry> = {}): QueueStoredEntry {
  return {
    sessionName: 'deck',
    queueEpoch: 'epoch',
    queueAuthorityId: 'authority',
    clientMessageId: 'msg-1',
    text: 'hello',
    status: 'queued',
    placement: 'normal',
    ordinal: 1,
    createdAt: 100,
    updatedAt: 100,
    pendingMessageVersion: 1,
    ...input,
  };
}

describe('transport queue privacy helpers', () => {
  it('builds queue projection entries by allowlist only', () => {
    const projection = buildQueueProjectionEntry(storedEntry({
      commandId: 'cmd-1',
      privateMaterialRef: 'private-ref',
      attachments: [
        {
          attachmentId: 'att-1',
          filename: 'safe.txt',
          mimeType: 'text/plain',
          size: 12,
        },
        {
          attachmentId: 'att-2',
          filename: 'unsafe.txt',
          daemonPath: '/tmp/raw-local-path',
        } as never,
      ],
      sharedActor: {
        actorId: 'actor-1',
        displayName: 'Agent',
        rawSharedActorEnvelope: { secret: 'do-not-project' },
      } as never,
    }));

    const serialized = JSON.stringify(projection);
    expect(projection.commandId).toBe('cmd-1');
    expect(serialized).not.toContain('private-ref');
    expect(serialized).not.toContain('/tmp/raw-local-path');
    expect(serialized).not.toContain('rawSharedActorEnvelope');
    expect(containsProhibitedQueueProjectionField(projection)).toBe(false);
  });

  it('detects prohibited projection fields in diagnostics or relay payloads', () => {
    for (const [key, value] of Object.entries({
      messagePreamble: 'private',
      daemonPath: '/tmp/local-attachment',
      rawProviderPayload: { raw: true },
      providerPayload: { raw: true },
      toolInput: 'raw input',
      toolOutput: 'raw output',
      env: { TOKEN: 'secret' },
      secret: 'secret',
      secrets: ['secret'],
      rawSessionHistory: ['history'],
      rawSharedActorEnvelope: { route: 'hidden' },
      sharedActorEnvelope: { route: 'hidden' },
      fullChildTranscript: 'child transcript',
      timelineCommitted: true,
      historyCommitted: true,
      privateMaterialRef: 'private-ref',
      providerRouting: { model: 'secret-route' },
    })) {
      expect(containsProhibitedQueueProjectionField({ nested: { [key]: value } })).toBe(true);
    }
    expect(containsProhibitedQueueProjectionField({
      nested: {
        clientMessageId: 'safe',
        text: 'safe',
      },
    })).toBe(false);
  });

  it('projects shared actor metadata without raw envelopes or transcripts', () => {
    const projection = buildQueueSharedActorProjection({
      id: 'actor-1',
      name: 'Reviewer',
      role: 'auditor',
      fullChildTranscript: 'private transcript',
      rawSharedActorEnvelope: { token: 'secret' },
    });
    expect(projection).toEqual({
      actorId: 'actor-1',
      displayName: 'Reviewer',
      role: 'auditor',
    });
    expect(JSON.stringify(projection)).not.toContain('private transcript');
    expect(JSON.stringify(projection)).not.toContain('secret');
  });
});
