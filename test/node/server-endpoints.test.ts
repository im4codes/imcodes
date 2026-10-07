import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTROLLED_NODE_ENDPOINTS,
  CONTROLLED_NODE_ENDPOINTS_FILE,
  normalizeControlledNodeEndpointList,
  normalizeControlledNodeEndpointOrigin,
  parseControlledNodePublicUrls,
} from '../../shared/controlled-node-endpoints.js';
import {
  ControlledNodeEndpointSelector,
  controlledNodeEndpointsPath,
  emptyEndpointState,
  parseEndpointState,
  readEndpointState,
  updatePinnedEndpoints,
  writeEndpointState,
  type ControlledNodeEndpointState,
} from '../../src/node/server-endpoints.js';

const PRIMARY = 'https://im.zhinet.work';
const PROXY = 'https://im-proxy.koca.win';
const OTHER = 'https://backup.example';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tempDir = async () => { const dir = await mkdtemp(join(tmpdir(), 'imcodes-endpoints-')); dirs.push(dir); return dir; };

function selector(state: Partial<ControlledNodeEndpointState> = {}) {
  let clock = 1_800_000_000_000;
  const persisted: ControlledNodeEndpointState[] = [];
  const rotations: Array<{ from: string; to: string }> = [];
  const instance = new ControlledNodeEndpointSelector(PRIMARY, { ...emptyEndpointState(), ...state }, {
    now: () => clock,
    persist: (next) => { persisted.push(next); },
    onRotate: (event) => { rotations.push({ from: event.from, to: event.to }); },
  });
  return { instance, persisted, rotations, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

const fail = (s: ReturnType<typeof selector>, times: number) => { for (let i = 0; i < times; i += 1) s.instance.recordFailure('connect_timeout'); };

describe('origin validation (one definition for enrollment, the list, the CLI and the server)', () => {
  it.each([
    ['https://im.example', 'https://im.example'],
    ['https://IM.Example:8443', 'https://im.example:8443'],
  ])('accepts %s', (input, expected) => expect(normalizeControlledNodeEndpointOrigin(input)).toBe(expected));

  it.each([
    'http://im.example', 'https://user:pw@im.example', 'https://im.example/path', 'https://im.example/?q=1', 'https://im.example/#x',
    'ftp://im.example', 'not a url', '', 42, null, `https://${'a'.repeat(600)}.example`,
  ])('rejects %j', (input) => expect(normalizeControlledNodeEndpointOrigin(input)).toBeNull());

  it('allows plain http only on loopback and only when asked', () => {
    expect(normalizeControlledNodeEndpointOrigin('http://127.0.0.1:3000')).toBeNull();
    expect(normalizeControlledNodeEndpointOrigin('http://127.0.0.1:3000', { allowLoopbackHttp: true })).toBe('http://127.0.0.1:3000');
    expect(normalizeControlledNodeEndpointOrigin('http://evil.example', { allowLoopbackHttp: true })).toBeNull();
  });

  it('a list is normalized, de-duplicated, bounded and drops what is invalid', () => {
    expect(normalizeControlledNodeEndpointList([PROXY, 'http://x.example', PROXY, 'https://IM-PROXY.koca.win', OTHER]))
      .toEqual([PROXY, OTHER]);
    const many = Array.from({ length: 9 }, (_, i) => `https://h${i}.example`);
    expect(normalizeControlledNodeEndpointList(many)).toHaveLength(CONTROLLED_NODE_ENDPOINTS.MAX_ALTERNATES);
    expect(normalizeControlledNodeEndpointList('https://x.example')).toEqual([]);
  });

  it('the server environment value is comma or space separated and empty by default', () => {
    expect(parseControlledNodePublicUrls(undefined)).toEqual([]);
    expect(parseControlledNodePublicUrls('')).toEqual([]);
    expect(parseControlledNodePublicUrls(`${PRIMARY}, ${PROXY}  junk`)).toEqual([PRIMARY, PROXY]);
  });
});

describe('endpoint state file', () => {
  it('writes atomically with mode 0644 and reads back what was written', async () => {
    const dir = await tempDir();
    const path = controlledNodeEndpointsPath(join(dir, 'install-journal.json'));
    expect(path.endsWith(CONTROLLED_NODE_ENDPOINTS_FILE)).toBe(true);
    const state: ControlledNodeEndpointState = { ...emptyEndpointState(), pinned: [PROXY], advertised: [OTHER], lastGood: PROXY, dropped: { [OTHER]: 5 } };
    await writeEndpointState(path, state);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect(await readEndpointState(path)).toEqual(state);
    expect(await readdir(dir)).toEqual([CONTROLLED_NODE_ENDPOINTS_FILE]); // no temp file left behind
  });

  it.each([
    ['not json', 'not json {'],
    ['wrong version', JSON.stringify({ version: 9, pinned: [PROXY] })],
    ['an array', '[1,2]'],
    ['oversized', ' '.repeat(CONTROLLED_NODE_ENDPOINTS.FILE_MAX_BYTES + 1)],
  ])('a damaged file (%s) means no alternates, never a failure', async (_name, content) => {
    const dir = await tempDir();
    const path = join(dir, CONTROLLED_NODE_ENDPOINTS_FILE);
    await writeFile(path, content);
    expect(await readEndpointState(path)).toEqual(emptyEndpointState());
  });

  it('a missing file means no alternates', async () => {
    expect(await readEndpointState(join(await tempDir(), 'nope.json'))).toEqual(emptyEndpointState());
  });

  it('every field is validated as untrusted input: bad origins, bad times and non-https entries are dropped', () => {
    const state = parseEndpointState({
      version: 1,
      pinned: [PROXY, 'http://evil.example', 'https://u:p@x.example', 7],
      advertised: ['javascript:alert(1)', OTHER],
      lastGood: 'http://evil.example',
      dropped: { [OTHER]: 'tomorrow', [PROXY]: 123, 'http://evil.example': 5 },
    });
    expect(state).toEqual({ version: 1, pinned: [PROXY], advertised: [OTHER], dropped: { [PROXY]: 123 } });
  });

  it('the CLI helper adds a valid origin, rejects an invalid one, removes, and keeps what the node wrote', async () => {
    const dir = await tempDir();
    const path = join(dir, CONTROLLED_NODE_ENDPOINTS_FILE);
    await writeEndpointState(path, { ...emptyEndpointState(), advertised: [OTHER], lastGood: OTHER });
    expect(await updatePinnedEndpoints(path, { add: `${PROXY}` })).toEqual([PROXY]);
    expect(await updatePinnedEndpoints(path, { add: `${PROXY}` })).toEqual([PROXY]);
    await expect(updatePinnedEndpoints(path, { add: 'http://evil.example' })).rejects.toThrow('server_url_must_be_an_https_origin');
    await expect(updatePinnedEndpoints(path, { add: 'https://x.example/path' })).rejects.toThrow('server_url_must_be_an_https_origin');
    expect(await readEndpointState(path)).toMatchObject({ pinned: [PROXY], advertised: [OTHER], lastGood: OTHER });
    expect(await updatePinnedEndpoints(path, { remove: PROXY })).toEqual([]);
    await updatePinnedEndpoints(path, { add: PROXY });
    expect(await updatePinnedEndpoints(path, { clear: true })).toEqual([]);
  });
});

describe('endpoint selection (injected clock)', () => {
  it('uses the credential origin when nothing else is known, and never rotates with a single candidate', () => {
    const s = selector();
    expect(s.instance.current()).toBe(PRIMARY);
    fail(s, 20);
    expect(s.instance.current()).toBe(PRIMARY);
    expect(s.rotations).toEqual([]);
  });

  it('begins on the origin that last authenticated, if it is still a candidate', () => {
    expect(selector({ advertised: [PROXY], lastGood: PROXY }).instance.current()).toBe(PROXY);
    expect(selector({ advertised: [], lastGood: PROXY }).instance.current()).toBe(PRIMARY);
  });

  it('rotates to the next origin after exactly FAILURES_BEFORE_ROTATE failures in a row, in the order primary, pinned, advertised', () => {
    const s = selector({ pinned: [OTHER], advertised: [PROXY] });
    fail(s, CONTROLLED_NODE_ENDPOINTS.FAILURES_BEFORE_ROTATE - 1);
    expect(s.instance.current()).toBe(PRIMARY);
    fail(s, 1);
    expect(s.instance.current()).toBe(OTHER);
    fail(s, CONTROLLED_NODE_ENDPOINTS.FAILURES_BEFORE_ROTATE);
    expect(s.instance.current()).toBe(PROXY);
  });

  it('a success resets the count; failures must be in a row', () => {
    const s = selector({ advertised: [PROXY] });
    fail(s, 2);
    s.instance.recordSuccess();
    fail(s, 2);
    expect(s.instance.current()).toBe(PRIMARY);
  });

  it('stays on a working origin: after switching it does not go back to the primary on its own', () => {
    const s = selector({ advertised: [PROXY] });
    fail(s, 3);
    expect(s.instance.current()).toBe(PROXY);
    s.instance.recordSuccess();
    s.advance(3_600_000);
    expect(s.instance.current()).toBe(PROXY);
    expect(s.persisted.at(-1)?.lastGood).toBe(PROXY);
  });

  it('an origin that failed is left on a doubling cooldown, up to the cap, before it is tried again', () => {
    const s = selector({ advertised: [PROXY] });
    const seen: string[] = [];
    // Both origins are dead: the node alternates, and each origin waits longer every round.
    for (let round = 0; round < 12; round += 1) {
      fail(s, 3);
      seen.push(s.instance.current());
      s.advance(1_000);
    }
    expect(new Set(seen)).toEqual(new Set([PRIMARY, PROXY]));
    // After a long quiet time everything is available again and the cap bounds the wait.
    s.advance(CONTROLLED_NODE_ENDPOINTS.COOLDOWN_MAX_MS * 2);
    const before = s.instance.current();
    fail(s, 3);
    expect(s.instance.current()).not.toBe(before);
  });

  it('when every origin is cooling down it picks the one that is free soonest instead of stopping', () => {
    const s = selector({ advertised: [PROXY, OTHER] });
    fail(s, 3); // PRIMARY cooling 5 s -> PROXY
    fail(s, 3); // PROXY cooling 5 s -> OTHER
    fail(s, 3); // OTHER cooling 5 s -> PRIMARY is the one that frees first
    expect(s.instance.current()).toBe(PRIMARY);
  });

  it('an origin that rejects the credential is dropped for 24 h and the node returns to the primary; the primary itself is never dropped', () => {
    const s = selector({ advertised: [PROXY] });
    fail(s, 3);
    expect(s.instance.current()).toBe(PROXY);
    expect(s.instance.recordRejected('authentication_failed')).toBe(PRIMARY);
    expect(s.instance.candidates()).toEqual([PRIMARY]);
    s.advance(CONTROLLED_NODE_ENDPOINTS.MISMATCH_DROP_MS - 1);
    expect(s.instance.candidates()).toEqual([PRIMARY]);
    s.advance(2);
    expect(s.instance.candidates()).toEqual([PRIMARY, PROXY]);
    expect(s.instance.recordRejected('authentication_failed')).toBe(PRIMARY);
    expect(s.instance.candidates()).toContain(PRIMARY);
  });

  it('a dropped origin is not used as the starting point after a restart', () => {
    const s = selector({ advertised: [PROXY], lastGood: PROXY, dropped: { [PROXY]: 1_800_000_000_000 + 1_000 } });
    expect(s.instance.current()).toBe(PRIMARY);
  });

  it('persists only when something changed, and records the advertised list', () => {
    const s = selector();
    s.instance.setAdvertised([PROXY, 'http://evil.example']);
    s.instance.setAdvertised([PROXY]);
    expect(s.persisted).toHaveLength(1);
    expect(s.persisted[0]!.advertised).toEqual([PROXY]);
    s.instance.recordSuccess();
    s.instance.recordSuccess();
    s.instance.recordSuccess();
    expect(s.persisted).toHaveLength(2); // lastGood once
  });

  it('a failing persist never reaches the connection', () => {
    const instance = new ControlledNodeEndpointSelector(PRIMARY, emptyEndpointState(), {
      persist: () => { throw new Error('read-only file system'); },
    });
    expect(() => { instance.setAdvertised([PROXY]); instance.recordSuccess(); }).not.toThrow();
  });
});
