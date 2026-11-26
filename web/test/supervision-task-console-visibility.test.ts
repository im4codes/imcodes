import { describe, expect, it } from 'vitest';
import { canViewSupervisionTaskConsole } from '../src/supervision-task-console-visibility.js';

describe('supervision task console visibility', () => {
  it('allows the original unshared Brain session', () => {
    expect(canViewSupervisionTaskConsole({
      session: { role: 'brain' },
      shareTargetKind: null,
      sharedAccessRole: null,
    })).toBe(true);
  });

  it.each([
    ['main', 'participant'], ['main', 'viewer'], ['server', 'participant'], ['server', 'viewer'],
  ] as const)('allows a %s share %s (the share covers the Brain)', (shareTargetKind, sharedAccessRole) => {
    expect(canViewSupervisionTaskConsole({
      session: { role: 'brain' },
      shareTargetKind,
      sharedAccessRole,
    })).toBe(true);
  });

  it.each([
    ['participant in a sub-session share', 'subsession', 'participant'],
    ['viewer in a sub-session share', 'subsession', 'viewer'],
  ] as const)('rejects a %s', (_label, shareTargetKind, sharedAccessRole) => {
    expect(canViewSupervisionTaskConsole({
      session: { role: 'brain' },
      shareTargetKind,
      sharedAccessRole,
    })).toBe(false);
  });

  it('fails closed when a whole-server share has no authoritative access role', () => {
    expect(canViewSupervisionTaskConsole({
      session: { role: 'brain' },
      shareTargetKind: 'server',
      sharedAccessRole: null,
    })).toBe(false);
  });

  it('fails closed when a shared main session has no authoritative access role', () => {
    expect(canViewSupervisionTaskConsole({
      session: { role: 'brain' },
      shareTargetKind: 'main',
      sharedAccessRole: null,
    })).toBe(false);
    expect(canViewSupervisionTaskConsole({
      session: { role: 'brain' },
      shareTargetKind: 'main',
      sharedAccessRole: undefined,
    })).toBe(false);
  });

  it.each(['w1', 'w2'] as const)('never treats a %s worker session as Brain', (role) => {
    expect(canViewSupervisionTaskConsole({
      session: { role },
      shareTargetKind: null,
      sharedAccessRole: null,
    })).toBe(false);
    expect(canViewSupervisionTaskConsole({
      session: { role },
      shareTargetKind: 'main',
      sharedAccessRole: 'participant',
    })).toBe(false);
  });

  it('fails closed without a resolved session', () => {
    expect(canViewSupervisionTaskConsole({
      session: null,
      shareTargetKind: 'main',
      sharedAccessRole: 'participant',
    })).toBe(false);
  });
});
