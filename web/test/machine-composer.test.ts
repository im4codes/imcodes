import { describe, expect, it, vi } from 'vitest';
import { matchInlineMachineTrigger, stripInlineMachineTrigger } from '../src/util/machine-trigger.js';
import { buildMachineSendExtra } from '../src/util/machine-send.js';
import { insertMachineMarkerAtCaret } from '../src/util/machine-insert.js';
import {
  buildMachineComposerReference,
  buildMachineMarker,
  parseMachineMarkers,
  type MachineRef,
} from '@shared/machine-reference.js';

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

describe('human-readable machine references', () => {
  it('keeps the stable ref as the only routing marker and appends the display note', () => {
    const reference = buildMachineComposerReference('win-1', 'Office PC');
    expect(reference).toBe('^^(win-1)-(Office PC)');
    expect(parseMachineMarkers(reference)).toEqual(['win-1']);
    expect(buildMachineSendExtra(reference, [ref('win-1', 'srv-win')]))
      .toEqual({ resolvedMachines: { 'win-1': 'srv-win' } });
  });

  it('neutralizes protocol-looking text inside a display note', () => {
    const reference = buildMachineComposerReference(
      'win-1',
      'Office @@all ;;(secret) ^^(other)',
    );
    expect(reference).toBe('^^(win-1)-(Office ＠＠all ；；(secret) ＾＾(other))');
    expect(parseMachineMarkers(reference)).toEqual(['win-1']);
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['control character', 'Office\nPC'],
    ['bidirectional override', 'Office\u202ePC'],
    ['over length', 'x'.repeat(121)],
  ] as const)('falls back to the stable marker for a %s display note', (_label, displayName) => {
    const reference = buildMachineComposerReference('win-1', displayName);
    expect(reference).toBe('^^(win-1)');
    expect(parseMachineMarkers(reference)).toEqual(['win-1']);
  });

  it('inserts the annotated reference at the caret', () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    try {
      expect(insertMachineMarkerAtCaret('win-1', 'Office PC')).toBe(true);
      expect(execCommand).toHaveBeenCalledWith('insertText', false, '^^(win-1)-(Office PC)');
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });
});
