import { describe, expect, it } from 'vitest';

import {
  DAEMON_MACHINE_LIST_ITEM_KEYS,
  DAEMON_MACHINE_LIST_SENT_KEYS,
  pickDaemonMachineListItem,
} from '../../shared/remote-exec.js';

/**
 * The control plane went down because two hand-maintained lists drifted: the
 * Server added `hostServerId` to the machine DTO, its daemon-facing strip list
 * was not extended, and every strict daemon rejected the WHOLE list as
 * malformed. These assertions make that drift impossible to ship.
 */
describe('daemon machine-list contract', () => {
  it('never sends a daemon a key that daemon would reject', () => {
    const unknown = DAEMON_MACHINE_LIST_SENT_KEYS
      .filter((key) => !DAEMON_MACHINE_LIST_ITEM_KEYS.has(key));
    expect(unknown).toEqual([]);
  });

  it('picks only sent keys, so a newly added field cannot leak to a strict daemon', () => {
    const picked = pickDaemonMachineListItem({
      serverId: 's1',
      nodeId: '1234567890',
      name: 'n',
      refName: 'r',
      displayName: 'D',
      online: true,
      nodeRole: 'controlled',
      execEnabled: true,
      // Everything below is either deliberately daemon-invisible today, or a
      // field nobody has invented yet. Both must be absent without anyone
      // remembering to exclude them.
      accessRole: 'owner',
      hostServerId: 'daemon-server-id',
      // The pair that actually took the control plane down.
      teamIds: ['t1'],
      teamNames: ['Group One'],
      capabilities: ['x'],
      remoteDesktopHostId: 'rd',
      someFutureFieldNobodyHasWrittenYet: 'boom',
    });
    expect(Object.keys(picked).sort()).toEqual([
      'displayName', 'execEnabled', 'name', 'nodeId', 'nodeRole', 'online', 'refName', 'serverId',
    ]);
  });

  it('a machine in a group is still accepted by a daemon built before groups existed', () => {
    // The exact outage: the Server began emitting teamIds/teamNames, and every
    // daemon built before the matching allow-list entry rejected the WHOLE
    // machine list. One grouped machine cost the account control of all of them.
    const DAEMON_BEFORE_GROUPS: ReadonlySet<string> = new Set([
      'serverId', 'nodeId', 'name', 'refName', 'displayName', 'online', 'nodeRole',
      'execEnabled', 'os', 'lastSeenMs', 'accessRole', 'daemonVersion',
      'updateAvailable', 'autoUnlockConfigured',
    ]);
    const picked = pickDaemonMachineListItem({
      serverId: 's1',
      nodeId: '6321982267',
      name: 'office',
      refName: 'office',
      displayName: '办公室调试机',
      online: true,
      nodeRole: 'controlled',
      execEnabled: true,
      os: 'win',
      lastSeenMs: 1,
      teamIds: ['t1'],
      teamNames: ['Group One'],
    });
    const rejected = Object.keys(picked).filter((key) => !DAEMON_BEFORE_GROUPS.has(key));
    expect(rejected).toEqual([]);
  });

  it('omits absent optional keys rather than emitting undefined', () => {
    const picked = pickDaemonMachineListItem({ serverId: 's1', online: true });
    expect(Object.keys(picked).sort()).toEqual(['online', 'serverId']);
  });
});
