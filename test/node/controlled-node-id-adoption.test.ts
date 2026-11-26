import { describe, expect, it, vi } from 'vitest';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import {
  CONTROLLED_NODE_ACK_NODE_ID_FIELD,
  CONTROLLED_NODE_ACK_SERVER_ID_FIELD,
} from '../../shared/controlled-node-identity.js';
import {
  CONTROLLED_NODE_ID_PERSIST_MAX_ATTEMPTS,
  assignedIdentityOfAck,
  createControlledNodeIdAdopter,
} from '../../src/node/controlled-node-id-adoption.js';
import type { ControlledNodeCredential } from '../../src/node/enrollment.js';

const SERVER_ID = '34f0bb116c897282b863d4391fd517a0';
const NODE_ID = '9909368908';
// A credential written before controlled nodes had a public ID: no `nodeId`.
const legacyCredential = (): ControlledNodeCredential => ({
  serverId: SERVER_ID, token: 'secret-token', serverUrl: 'https://im.example', nodeRole: NODE_ROLE.CONTROLLED, refName: 'desktop-1', displayName: 'Desktop 1',
});
const log = () => ({ info: vi.fn(), warn: vi.fn() });

function adopter(overrides: Partial<Parameters<typeof createControlledNodeIdAdopter>[0]> = {}) {
  const persist = vi.fn(async (_credential: ControlledNodeCredential) => undefined);
  const start = vi.fn(async (_nodeId: string) => undefined);
  const logger = log();
  const adopt = createControlledNodeIdAdopter({ credential: legacyCredential(), persist, start, log: logger, ...overrides });
  return { adopt, persist, start, logger };
}
// No default parameters: `undefined` has to mean "the field is absent".
const ack = (nodeId: unknown, ...serverId: [unknown?]) => ({ nodeId, serverId: serverId.length > 0 ? serverId[0] : SERVER_ID });
const good = () => ack(NODE_ID);

describe('a legacy credential adopts the public node ID the server assigns', () => {
  it('starts the local management surface once and writes the ID back with every other field kept', async () => {
    const h = adopter();
    await h.adopt(good());
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith(NODE_ID);
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.persist).toHaveBeenCalledWith({ ...legacyCredential(), nodeId: NODE_ID });
    // Every later ack of the same connection changes nothing.
    await h.adopt(good());
    await h.adopt(good());
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it('adopts only a canonical 10-digit ID', async () => {
    const h = adopter();
    for (const bad of [undefined, null, 9909368908, '', '990936890', '99093689080', '0909368908', '99093689O8', ' 9909368908', '9909368908\n']) {
      await h.adopt(ack(bad));
    }
    expect(h.start).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('adopts only from an ack addressed to this node\'s own server ID, and says so once', async () => {
    const h = adopter();
    await h.adopt(ack(NODE_ID, undefined));
    await h.adopt(ack(NODE_ID, 'someone-else'));
    await h.adopt(ack(NODE_ID, 'someone-else'));
    expect(h.start).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('never replaces an ID the credential already holds, however often it is offered a different one', async () => {
    const held = { ...legacyCredential(), nodeId: '1234567890' };
    const h = adopter({ credential: held });
    await h.adopt(ack(NODE_ID));
    await h.adopt(ack(NODE_ID));
    expect(h.start).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    // The same ID it holds is simply nothing to do.
    const same = adopter({ credential: held });
    await same.adopt(ack('1234567890'));
    expect(same.persist).not.toHaveBeenCalled();
    expect(same.logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the first adopted ID if a later ack offers another one', async () => {
    const h = adopter();
    await h.adopt(ack(NODE_ID));
    await h.adopt(ack('1111111111'));
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.persist).toHaveBeenCalledWith(expect.objectContaining({ nodeId: NODE_ID }));
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('starts the surface even when the credential cannot be written, retries on later acks, and stops after a bounded number of tries', async () => {
    const persist = vi.fn(async () => { throw new Error('EACCES'); });
    const h = adopter({ persist });
    for (let index = 0; index < CONTROLLED_NODE_ID_PERSIST_MAX_ATTEMPTS + 6; index += 1) await h.adopt(good());
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(CONTROLLED_NODE_ID_PERSIST_MAX_ATTEMPTS);
    // One warning for the first failure and one when it gives up: not one per heartbeat.
    expect(h.logger.warn).toHaveBeenCalledTimes(2);
    expect(h.logger.info).not.toHaveBeenCalled();
  });

  it('records the ID as soon as a retry succeeds and then stops writing', async () => {
    let failures = 2;
    const persist = vi.fn(async () => { if (failures-- > 0) throw new Error('busy'); });
    const h = adopter({ persist });
    for (let index = 0; index < 6; index += 1) await h.adopt(good());
    expect(persist).toHaveBeenCalledTimes(3);
    expect(h.logger.info).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('never lets a failing surface start reach the node, and still records the ID', async () => {
    const failingStart = vi.fn(async () => { throw new Error('EADDRINUSE 43751'); });
    const h = adopter({ start: failingStart });
    await expect(h.adopt(good())).resolves.toBeUndefined();
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ nodeId: NODE_ID }), expect.stringContaining('could not start'));
    // The start is not retried on every heartbeat.
    await h.adopt(good());
    expect(failingStart).toHaveBeenCalledTimes(1);
  });

  it('writes the credential once when two acks arrive while the first write is still running', async () => {
    let release!: () => void;
    const persist = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const h = adopter({ persist });
    const first = h.adopt(good());
    const second = h.adopt(good());
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('reads the identity from an ack frame by the shared field names', () => {
    expect(assignedIdentityOfAck({ type: 'heartbeat_ack', [CONTROLLED_NODE_ACK_NODE_ID_FIELD]: NODE_ID, [CONTROLLED_NODE_ACK_SERVER_ID_FIELD]: SERVER_ID }))
      .toEqual({ nodeId: NODE_ID, serverId: SERVER_ID });
    expect(assignedIdentityOfAck({ type: 'heartbeat_ack' })).toEqual({ nodeId: undefined, serverId: undefined });
  });
});
