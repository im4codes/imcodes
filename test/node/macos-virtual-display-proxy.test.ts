import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  MACOS_VIRTUAL_DISPLAY_PROXY_MAX_LINE_BYTES,
  MACOS_VIRTUAL_DISPLAY_PROXY_OP,
  authorVirtualDisplayControlLine,
  parseVirtualDisplayControlReply,
  proxyVirtualDisplayRequest,
  validateVirtualDisplayProxyRequest,
  type MacosVirtualDisplayProxyLease,
  type MacosVirtualDisplayProxyRequest,
} from '../../src/node/macos-virtual-display-proxy.js';

const lease: MacosVirtualDisplayProxyLease = {
  socket: {} as unknown as Socket,
  serviceGeneration: 7,
  auditSessionId: 100_003,
};

/** Records every line the agent was actually asked. */
function agent(answers: Array<string | null>) {
  const asked: string[] = [];
  let index = 0;
  return {
    asked,
    seams: {
      async exchange(_lease: MacosVirtualDisplayProxyLease, line: string) {
        asked.push(line);
        const answer = answers[index] ?? null;
        index += 1;
        return answer;
      },
    },
  };
}

const STATUS = MACOS_VIRTUAL_DISPLAY_PROXY_OP.STATUS;

describe('macOS virtual-display daemon proxy', () => {
  it('authors the route generation itself and ignores the frame', async () => {
    // This is the whole reason the daemon authors rather than forwards: a
    // worker must not be able to name a route belonging to another session,
    // and the way to guarantee that is to leave it no field in which to ask.
    const hostile = {
      op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.ROUTE,
      routeGeneration: 99,
      rgen: 99,
    } as unknown;
    // The extra keys are refused outright rather than ignored.
    expect(validateVirtualDisplayProxyRequest(hostile)).toBeNull();

    const { asked, seams } = agent(['ctl1r ok=1 rgen=4 repoch=11 seed=22 uid=501']);
    const reply = await proxyVirtualDisplayRequest(
      lease, { op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.ROUTE }, 4, seams,
    );
    expect(reply.ok).toBe(true);
    // The AUTHENTICATED generation, not 99.
    expect(asked).toEqual(['ctl1 verb=route rgen=4']);
    expect(reply.routeEpoch).toBe(11);
    expect(reply.cookieSeed).toBe(22);
  });

  it('gives readiness a nonce and no way to ask for a mutation', async () => {
    const request = validateVirtualDisplayProxyRequest({
      op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS, nonce: 42,
    });
    expect(request).not.toBeNull();
    expect(authorVirtualDisplayControlLine(request!, 4))
      .toBe('ctl1 verb=ready nonce=42');

    // Every field that could describe an action is refused ON the readiness op.
    for (const field of ['routeEpoch', 'routeCookie', 'requestIndex', 'displayId',
                         'pixelsWide', 'pixelsHigh', 'refreshMilliHertz', 'scalePercent']) {
      expect(validateVirtualDisplayProxyRequest({
        op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS, nonce: 42, [field]: 1,
      }), `readiness accepted ${field}`).toBeNull();
    }
    // And a readiness round trip only ever emits `verb=ready`. The answer
    // states both flags explicitly: a missing `admittedctl` used to read as a
    // definite "not admitted", which is a verdict the agent never gave.
    const { asked, seams } = agent(['ctl1r ok=1 nonce=42 qualified=1 admittedctl=0']);
    const reply = await proxyVirtualDisplayRequest(lease, request!, 4, seams);
    expect(reply.ok).toBe(true);
    expect(reply.qualifiedToCreate).toBe(true);
    expect(reply.displayControlAdmitted).toBe(false);
    expect(asked).toEqual(['ctl1 verb=ready nonce=42']);
    expect(asked.join(' ')).not.toMatch(/hold|enable|relay|route/u);
  });

  it('refuses a readiness answer to a different question', async () => {
    // Without the nonce check a status reply proves only that SOMETHING
    // answered -- a stale frame still in the buffer would read as a live
    // admission.
    const { seams } = agent(['ctl1r ok=1 nonce=41 qualified=1 admittedctl=1']);
    const reply = await proxyVirtualDisplayRequest(
      lease, { op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS, nonce: 42 }, 4, seams,
    );
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('agent_answered_another_question');
    // And nothing usable leaked out of the refusal.
    expect(reply.displayControlAdmitted).toBeUndefined();
  });

  it('fails closed on every way the agent can fail to answer', async () => {
    for (const [what, answers] of [
      ['a timeout or dead lease', [null]],
      ['an empty answer', ['']],
      ['a frame from another protocol', ['grant1 uid=501']],
      ['a malformed frame', ['ctl1r nonsense']],
      ['a duplicated key', ['ctl1r ok=1 ok=0']],
      ['an oversize frame', [`ctl1r ok=1 x=${'y'.repeat(600)}`]],
      ['an explicit refusal', ['ctl1r ok=0 error=route_unknown']],
    ] as const) {
      const { seams } = agent([...answers]);
      const reply = await proxyVirtualDisplayRequest(
        lease, { op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS, nonce: 42 }, 4, seams,
      );
      expect(reply.ok, `${what} was treated as success`).toBe(false);
      expect(reply.qualifiedToCreate, `${what} leaked a capability`).toBeFalsy();
      expect(reply.displayControlAdmitted, `${what} claimed a display`).toBeFalsy();
    }
  });

  it('reports no authority at all when there is no lease', async () => {
    // A daemon with no authenticated agent has no display authority, and says
    // so rather than leaving the caller to retry it into existence.
    const { asked, seams } = agent(['ctl1r ok=1 nonce=42 qualified=1']);
    const reply = await proxyVirtualDisplayRequest(
      null, { op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS, nonce: 42 }, 4, seams,
    );
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('agent_unavailable');
    expect(asked).toHaveLength(0);
  });

  it('carries the route credential on relays and the mode only on enable', () => {
    const relay = validateVirtualDisplayProxyRequest({
      op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.ENABLE,
      routeEpoch: 11, routeCookie: 22, requestIndex: 3,
      displayId: 42, pixelsWide: 1920, pixelsHigh: 1080,
      refreshMilliHertz: 60_000, scalePercent: 200,
    });
    expect(authorVirtualDisplayControlLine(relay!, 4)).toBe(
      'ctl1 verb=relay rgen=4 repoch=11 rcookie=22 ridx=3 op=enable'
      + ' display=42 w=1920 h=1080 hz=60000 scale=200',
    );

    // Mode on anything but enable is refused: the agent would not act on it,
    // and silently dropping it is how a mode selection vanishes.
    for (const op of [MACOS_VIRTUAL_DISPLAY_PROXY_OP.HOLD,
                      MACOS_VIRTUAL_DISPLAY_PROXY_OP.STATUS,
                      MACOS_VIRTUAL_DISPLAY_PROXY_OP.DISABLE]) {
      expect(validateVirtualDisplayProxyRequest({
        op, routeEpoch: 11, routeCookie: 22, requestIndex: 3, pixelsWide: 1920,
      }), `${op} accepted a mode`).toBeNull();
    }
    // hold and status address no display; disable must name one.
    expect(validateVirtualDisplayProxyRequest({
      op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.HOLD,
      routeEpoch: 11, routeCookie: 22, requestIndex: 3, displayId: 42,
    })).toBeNull();
    expect(validateVirtualDisplayProxyRequest({
      op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.DISABLE,
      routeEpoch: 11, routeCookie: 22, requestIndex: 3,
    })).toBeNull();
    // Every relay needs its whole credential.
    for (const missing of ['routeEpoch', 'routeCookie', 'requestIndex']) {
      const request: Record<string, unknown> = {
        op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.STATUS,
        routeEpoch: 11, routeCookie: 22, requestIndex: 3,
      };
      delete request[missing];
      expect(validateVirtualDisplayProxyRequest(request),
        `relay accepted without ${missing}`).toBeNull();
    }
  });

  it('has no way to express a release', () => {
    // The helper's lifetime IS the display's lifetime and it belongs to the
    // resident agent. A route that could release it would take the display away
    // from every other route and from the next one. There is no op for it, so
    // this is unrepresentable rather than refused on receipt.
    expect(Object.values(MACOS_VIRTUAL_DISPLAY_PROXY_OP)).not.toContain('release');
    for (const op of ['release', 'destroy', 'teardown', 'kill']) {
      expect(validateVirtualDisplayProxyRequest({
        op, routeEpoch: 11, routeCookie: 22, requestIndex: 3,
      }), `${op} was accepted`).toBeNull();
    }
  });

  it('never puts a helper credential on the worker side of the wire', async () => {
    // What a route receives is a ROUTE capability. The helper's epoch and
    // cookie seed belong to the agent's private channel and have no field here.
    const { asked, seams } = agent(['ctl1r ok=1 rgen=4 repoch=11 seed=22 uid=501']);
    const reply = await proxyVirtualDisplayRequest(
      lease, { op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.ROUTE }, 4, seams,
    );
    const encoded = JSON.stringify(reply);
    for (const forbidden of ['helperEpoch', 'helperCookie', 'helperSeed', 'fd']) {
      expect(encoded, `reply carried ${forbidden}`).not.toContain(forbidden);
    }
    expect(asked.join(' ')).not.toMatch(/helper/u);
  });

  it('cannot express a request that would overrun the wire bound', () => {
    // Every field is individually bounded, so the LARGEST line a valid request
    // can produce is fixed. Asserting that maximum is under the wire bound is
    // the real invariant; the length guard in the author is a backstop for
    // future field growth and is unreachable today, which is stated rather than
    // dressed up as a tested branch.
    const largest: MacosVirtualDisplayProxyRequest = {
      op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.ENABLE,
      routeEpoch: Number.MAX_SAFE_INTEGER,
      routeCookie: Number.MAX_SAFE_INTEGER,
      requestIndex: Number.MAX_SAFE_INTEGER,
      displayId: 4_294_967_294,
      pixelsWide: 16_384, pixelsHigh: 16_384,
      refreshMilliHertz: 240_000, scalePercent: 400,
    };
    const line = authorVirtualDisplayControlLine(largest, Number.MAX_SAFE_INTEGER);
    expect(line).not.toBeNull();
    // Comfortably inside, and asserted as a NUMBER so a field that grew past
    // the bound would fail here rather than silently start returning null.
    expect(line!.length).toBeLessThan(MACOS_VIRTUAL_DISPLAY_PROXY_MAX_LINE_BYTES);
    expect(line!.length).toBeLessThan(200);

    // A generation that is not a usable generation is refused outright.
    expect(authorVirtualDisplayControlLine(largest, 0)).toBeNull();
    expect(authorVirtualDisplayControlLine(largest, -1)).toBeNull();
    expect(authorVirtualDisplayControlLine(largest, 1.5)).toBeNull();
  });

  it('refuses a reply that is not this protocol', () => {
    // Defence in depth: the token structure below would refuse most of these
    // anyway, so the prefix check is not independently load-bearing. It is
    // tested rather than assumed so the behaviour is pinned either way.
    for (const line of ['ctl1 ok=1', 'ctl1rr ok=1', 'grant1 uid=501',
                        'chal1 challenge=x', 'ok=1']) {
      expect(parseVirtualDisplayControlReply(line, STATUS).ok, `${line} was accepted`)
        .toBe(false);
    }
    // A bare `ok=1` is no longer a relay answer: the shape requires the
    // admission and presence the caller is about to act on.
    expect(parseVirtualDisplayControlReply('ctl1r ok=1', STATUS).ok).toBe(false);
    expect(parseVirtualDisplayControlReply('ctl1r ok=1 admitted=1 presence=active', STATUS).ok)
      .toBe(true);
  });

  it('reads an agent reply strictly', () => {
    expect(parseVirtualDisplayControlReply(
      'ctl1r ok=1 display=42 admitted=1 presence=active', STATUS,
    )).toMatchObject({ ok: true, displayId: 42, admitted: true, presence: 'active' });
    // Leading zeros are two spellings of one value, and the agent emits one.
    expect(parseVirtualDisplayControlReply(
      'ctl1r ok=1 display=042 admitted=1 presence=active', STATUS,
    ).ok).toBe(false);
    for (const bad of ['', 'ctl1r', 'ctl1 ok=1', 'ctl1r ok=2', 'ctl1r =1', 'ctl1r ok']) {
      expect(parseVirtualDisplayControlReply(bad, STATUS).ok, `${bad} was accepted`)
        .toBe(false);
    }
  });

  it('holds each op to its own canonical answer shape', () => {
    // Every case below was ACCEPTED before the shape was pinned per op.
    const readiness = MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS;
    const route = MACOS_VIRTUAL_DISPLAY_PROXY_OP.ROUTE;

    // A readiness answer may not carry a capability. Accepting one meant a
    // zero-mutation question could hand back credentials.
    expect(parseVirtualDisplayControlReply(
      'ctl1r ok=1 nonce=7 qualified=1 admittedctl=1 repoch=9 seed=9', readiness,
    ).ok).toBe(false);
    expect(parseVirtualDisplayControlReply(
      'ctl1r ok=1 nonce=7 qualified=1 admittedctl=1', readiness,
    )).toMatchObject({ ok: true, nonce: 7, qualifiedToCreate: true });

    // Booleans are 0 or 1. `2` used to read as a definite false -- an answer
    // the daemon never received.
    expect(parseVirtualDisplayControlReply(
      'ctl1r ok=1 nonce=7 qualified=2 admittedctl=1', readiness,
    ).ok).toBe(false);
    // A missing flag is not a false one.
    expect(parseVirtualDisplayControlReply('ctl1r ok=1 nonce=7 qualified=1', readiness).ok)
      .toBe(false);

    // A route answer without a capability is not a route answer.
    expect(parseVirtualDisplayControlReply('ctl1r ok=1 rgen=4', route, 4).ok).toBe(false);
    expect(parseVirtualDisplayControlReply(
      'ctl1r ok=1 rgen=4 repoch=11 seed=12 uid=501', route, 4,
    )).toMatchObject({ ok: true, routeGeneration: 4, routeEpoch: 11, cookieSeed: 12 });
    // ...and it must be about the generation the daemon authored.
    expect(parseVirtualDisplayControlReply(
      'ctl1r ok=1 rgen=5 repoch=11 seed=12 uid=501', route, 4,
    )).toMatchObject({ ok: false, error: 'agent_answered_another_route' });

    // Unknown keys are refused rather than ignored.
    expect(parseVirtualDisplayControlReply(
      'ctl1r ok=1 admitted=1 presence=active surprise=1', STATUS,
    ).ok).toBe(false);
    // Presence is a closed set; an unknown token would fall to a caller's
    // default branch, and that branch reads as "not shown".
    expect(parseVirtualDisplayControlReply(
      'ctl1r ok=1 admitted=1 presence=probably', STATUS,
    ).ok).toBe(false);

    // A refusal is exactly ok=0 plus one bounded error token.
    expect(parseVirtualDisplayControlReply('ctl1r ok=0 error=denied', STATUS))
      .toMatchObject({ ok: false, error: 'denied' });
    expect(parseVirtualDisplayControlReply('ctl1r ok=0 error=denied extra=1', STATUS).error)
      .toBe('agent_frame_unusable');
    expect(parseVirtualDisplayControlReply('ctl1r ok=0', STATUS).error)
      .toBe('agent_frame_unusable');
  });
});
