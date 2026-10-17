import { describe, expect, it } from 'vitest';
import { MACHINE_ACTION, MACHINE_ACCESS_SOURCE as S, MACHINE_DENIAL_REASON as D, evaluateMachineAction, machineActionForComputerUseTool, type MachineAccessSubject } from '../../shared/machine-access-policy.js';

const subjects: Array<[string, MachineAccessSubject, boolean, boolean]> = [
  ['owner', { accessRole: 'owner', accessSource: S.OWNER, execGranted: false, execEnabled: true, participantTurn: true }, true, true],
  ['granted', { accessRole: 'participant', accessSource: S.SHARE, execGranted: true, execEnabled: true, participantTurn: true }, true, true],
  ['no grant', { accessRole: 'participant', accessSource: S.SHARE, execGranted: false, execEnabled: true, participantTurn: true }, true, false],
  ['group', { accessRole: 'participant', accessSource: S.GROUP, execGranted: true, execEnabled: true, participantTurn: true }, true, false],
  ['viewer', { accessRole: 'viewer', accessSource: S.SHARE, execGranted: false, execEnabled: true, participantTurn: true }, false, false],
  ['revoked', { accessRole: null, accessSource: null, execGranted: true, execEnabled: true, participantTurn: true }, false, false],
];
describe.each(subjects)('%s real access', (_name, subject, mayView, mayExecute) => {
  it.each(Object.values(MACHINE_ACTION))('participant vs owner turn for %s', (action) => {
    const expected = action === MACHINE_ACTION.EXEC ? false : action === MACHINE_ACTION.LIST || action === MACHINE_ACTION.VIEW ? mayView : mayExecute;
    expect(evaluateMachineAction(subject, action).allowed).toBe(expected);
    // With provenance absent, grant rules are identical except the exact exec_remote action.
    const ownerTurn = evaluateMachineAction({ ...subject, participantTurn: false }, action);
    expect(ownerTurn.allowed).toBe(action === MACHINE_ACTION.EXEC ? mayExecute : expected);
    const switchedOff = evaluateMachineAction({ ...subject, execEnabled: false }, action);
    expect(switchedOff.allowed).toBe(action === MACHINE_ACTION.LIST && mayView);
  });
});
it('computer shell is not exec_remote, unknown verbs retain execute-class grant checks', () => {
  expect(machineActionForComputerUseTool('shell_session1')).toBe(MACHINE_ACTION.SHELL_SESSION);
  expect(machineActionForComputerUseTool('list_apps')).toBe(MACHINE_ACTION.VIEW);
  expect(machineActionForComputerUseTool('future-tool')).toBe(MACHINE_ACTION.GUI_INPUT);
  expect(evaluateMachineAction(subjects[0]![1], 'unknown' as never)).toEqual({ allowed: false, reason: D.UNKNOWN_ACTION });
});
