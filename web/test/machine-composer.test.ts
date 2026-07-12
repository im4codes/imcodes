import { describe, expect, it } from 'vitest';
import { matchInlineMachineTrigger, stripInlineMachineTrigger } from '../src/util/machine-trigger.js';
import { buildMachineSendExtra } from '../src/util/machine-send.js';
import { buildMachineMarker, type MachineRef } from '@shared/machine-reference.js';

const ref = (refName: string, serverId: string, online = true): MachineRef => ({ refName, serverId, online });

describe('matchInlineMachineTrigger (8.3)', () => {
  it('opens on a lone `^` at start with an empty query', () => {
    expect(matchInlineMachineTrigger('^')).toBe('');
  });
  it('opens after whitespace and captures the query', () => {
    expect(matchInlineMachineTrigger('run ^win')).toBe('win');
    expect(matchInlineMachineTrigger('deploy to ^mac-a1')).toBe('mac-a1');
  });
  it('does not trigger mid-word (no word boundary before `^`)', () => {
    expect(matchInlineMachineTrigger('foo^bar')).toBeNull();
    expect(matchInlineMachineTrigger('a^')).toBeNull();
  });
  it('does not trigger on a `^^` marker prefix (typing `^^(name)`)', () => {
    expect(matchInlineMachineTrigger('go ^^')).toBeNull();
    expect(matchInlineMachineTrigger(`go ${buildMachineMarker('win')}`)).toBeNull();
  });
  it('does not trigger when the query is broken by a space', () => {
    expect(matchInlineMachineTrigger('^win now')).toBeNull();
  });
});

describe('stripInlineMachineTrigger (8.3)', () => {
  it('removes a trailing `^query` fragment, keeping the boundary whitespace', () => {
    expect(stripInlineMachineTrigger('run ^wi')).toBe('run ');
    expect(stripInlineMachineTrigger('^wi')).toBe('');
  });
  it('leaves text without a trailing trigger unchanged', () => {
    expect(stripInlineMachineTrigger('plain text')).toBe('plain text');
    expect(stripInlineMachineTrigger(`done ${buildMachineMarker('win')}`)).toBe(`done ${buildMachineMarker('win')}`);
  });
});

describe('buildMachineSendExtra (8.5)', () => {
  const list = [ref('win-1', 'srv-win'), ref('mac-1', 'srv-mac')];

  it('resolves a known marker to its serverId (marker stays literal in text)', () => {
    const extra = buildMachineSendExtra(`run ${buildMachineMarker('win-1')} now`, list);
    expect(extra).toEqual({ resolvedMachines: { 'win-1': 'srv-win' } });
  });
  it('returns a spread-safe empty object with no markers', () => {
    const extra = buildMachineSendExtra('plain message', list);
    expect(extra).toEqual({});
    expect({ ...extra }).toEqual({});
  });
  it('skips an unknown marker (left literal, not resolved)', () => {
    const extra = buildMachineSendExtra(`x ${buildMachineMarker('ghost')} y`, list);
    expect(extra).toEqual({});
  });
  it('skips an ambiguous marker (two machines share a ref_name)', () => {
    const dup = [ref('dup', 'a'), ref('dup', 'b')];
    const extra = buildMachineSendExtra(`${buildMachineMarker('dup')}`, dup);
    expect(extra).toEqual({});
  });
  it('resolves only markers present in the list', () => {
    const body = `${buildMachineMarker('win-1')} and ${buildMachineMarker('ghost')}`;
    expect(buildMachineSendExtra(body, list)).toEqual({ resolvedMachines: { 'win-1': 'srv-win' } });
  });
  it('rejects a nested-paren marker (not a valid machine marker)', () => {
    expect(buildMachineSendExtra('^^(na(me)', list)).toEqual({});
  });
});
