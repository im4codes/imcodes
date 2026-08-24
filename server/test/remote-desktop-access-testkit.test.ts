import { describe, expect, it } from 'vitest';
import {
  accessAuthorityFixture,
  BrowserKeyProofHarness,
  ConsentProviderHarness,
  DeterministicByteSource,
  DeterministicClock,
  DeterministicRateLimitHarness,
  DueOutboxHarness,
  hostStateFixture,
  KdfWorkCounter,
  linkedHostFixture,
  PodStickyHandoffHarness,
  principalMergeConflictFixture,
  PrivacyEpochHarness,
  RemoteSessionHarness,
  wallFixture,
  type PresentationSource,
} from './remote-desktop-access-testkit.js';

describe('remote desktop access testkit', () => {
  it('provides canonical linked, conflict, state, authority and wall fixtures', () => {
    expect(linkedHostFixture().fullServerId).toBe('full-server-1');
    expect(linkedHostFixture().controlledServerId).toBe('controlled-server-1');
    expect(principalMergeConflictFixture().requiresMergeResolution).toBe(true);
    expect(hostStateFixture('retired').publicNodeIdState).toBe('retired');
    expect(hostStateFixture('disabled').availability).toBe('disabled');
    expect(accessAuthorityFixture()).toMatchObject({
      authorityGeneration: 3,
      expiryRevision: 5,
      passwordGeneration: 7,
    });
    expect(wallFixture(16, 'turn')).toHaveLength(16);
    expect(new Set(wallFixture(16, 'turn').map((node) => node.remoteDesktopHostId)).size).toBe(16);
    const sources: PresentationSource[] = ['management_web', 'signed_shell'];
    expect(sources).toHaveLength(2);
  });

  it('drives deterministic clock, random bytes, browser proof, KDF work and rate limits', () => {
    const clock = new DeterministicClock(1_000);
    expect(clock.advance(50)).toBe(1_050);
    const random = new DeterministicByteSource(Uint8Array.from([1, 2, 3]));
    expect(Array.from(random.read(5))).toEqual([1, 2, 3, 1, 2]);

    const browserProof = new BrowserKeyProofHarness();
    const proof = browserProof.sign('browser-a', 'challenge-a');
    expect(browserProof.verify('browser-a', 'challenge-a', proof)).toBe(true);
    expect(browserProof.verify('browser-b', 'challenge-a', proof)).toBe(false);

    const work = new KdfWorkCounter();
    expect(work.run('lookup', 'unknown')).toHaveLength(64);
    expect(work.run('kdf', 'dummy')).toHaveLength(64);
    expect(work.stages).toEqual(['lookup', 'kdf']);

    const limiter = new DeterministicRateLimitHarness(clock, 2, 100);
    expect(limiter.take('source-a')).toBe(true);
    expect(limiter.take('source-a')).toBe(true);
    expect(limiter.take('source-a')).toBe(false);
    clock.advance(101);
    expect(limiter.take('source-a')).toBe(true);
  });

  it('models pod ownership, due claims and owning-pod acknowledgement', () => {
    const sticky = new PodStickyHandoffHarness();
    sticky.bind('server-a', 'pod-a');
    expect(sticky.resolve('server-a')).toBe('pod-a');
    expect(() => sticky.assertOwningPod('server-a', 'pod-b')).toThrow('wrong_pod');

    const queue = new DueOutboxHarness();
    queue.schedule({ linkId: 'link-a', expiryRevision: 4, expiresAt: 2_000 });
    expect(queue.claimDue(1_999, 'worker-a')).toEqual([]);
    expect(queue.claimDue(2_000, 'worker-a')).toHaveLength(1);
    expect(queue.claimDue(2_000, 'worker-b')).toEqual([]);
    queue.complete('link-a', 4, 'pod-a');
    queue.complete('link-a', 4, 'pod-a');
    expect(queue.outbox).toHaveLength(1);
    expect(() => queue.acknowledge('expiry:link-a:4', 'pod-b')).toThrow('wrong_pod');
    queue.acknowledge('expiry:link-a:4', 'pod-a');
    expect(queue.outbox[0]?.acknowledged).toBe(true);

    queue.schedule({ linkId: 'link-idle', expiryRevision: 2, expiresAt: 2_000 });
    expect(queue.claimDue(2_000, 'worker-a')).toHaveLength(1);
    queue.complete('link-idle', 2, null);
    expect(queue.outbox[1]).toMatchObject({ scope: 'host', targetPodId: null });
    expect(() => queue.acknowledge('expiry:link-idle:2', 'pod-b')).toThrow('wrong_pod');
    queue.acknowledge('expiry:link-idle:2', 'pod-b', 'pod-b');
    expect(queue.outbox[1]?.acknowledged).toBe(true);
  });

  it('models consent, privacy barriers and independent remote sessions', () => {
    const consent = new ConsentProviderHarness();
    consent.enqueue('allow');
    expect(consent.request()).toBe('allow');
    expect(consent.request()).toBe('timeout');

    const privacy = new PrivacyEpochHarness();
    const epoch = privacy.begin(['route-a', 'route-b']);
    privacy.acknowledge(epoch, 'route-a');
    expect(privacy.phase).toBe('starting');
    privacy.acknowledge(epoch, 'route-b');
    expect(privacy.phase).toBe('active');
    expect(() => privacy.finish(epoch, false)).toThrow('privacy_resume_forbidden');
    privacy.finish(epoch, true);
    expect(privacy.phase).toBe('idle');

    const sessions = new RemoteSessionHarness();
    sessions.connect('session-a', 'host-a', 'direct');
    sessions.connect('session-b', 'host-b', 'turn');
    sessions.disconnect('session-a');
    expect(sessions.sessions.get('session-a')?.connected).toBe(false);
    expect(sessions.sessions.get('session-b')?.connected).toBe(true);
  });
});
