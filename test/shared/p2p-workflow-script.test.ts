import { describe, expect, it } from 'vitest';
import {
  DEFAULT_P2P_SCRIPT_CAPS,
  parseP2pScriptMachineOutput,
  validateP2pScriptContract,
} from '../../shared/p2p-workflow-script.js';

describe('p2p workflow script helpers', () => {
  it('defaults script contracts to argv command kind and caps', () => {
    const result = validateP2pScriptContract({ argv: ['node', 'script.mjs'] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.commandKind).toBe('argv');
      expect(result.contract.argv).toEqual(['node', 'script.mjs']);
      expect(result.contract.caps).toEqual(DEFAULT_P2P_SCRIPT_CAPS);
    }
  });

  it('rejects invalid script contracts', () => {
    expect(validateP2pScriptContract({ commandKind: 'shell', argv: ['echo'] }).diagnostics[0]?.code).toBe('invalid_script_contract');
    expect(validateP2pScriptContract({ commandKind: 'argv', argv: [] }).diagnostics[0]?.code).toBe('invalid_script_contract');
    expect(validateP2pScriptContract({ commandKind: 'argv', argv: [''] }).diagnostics[0]?.code).toBe('invalid_script_contract');
    expect(validateP2pScriptContract({ commandKind: 'argv', argv: ['echo'], caps: { stdoutBytes: -1 } }).diagnostics[0]?.code).toBe('invalid_script_contract');
  });

  it('parses structured NDJSON machine output frames', () => {
    const result = parseP2pScriptMachineOutput([
      JSON.stringify({
        kind: 'p2p_script_machine_output_v1',
        routingKey: 'accepted',
        variables: { answer: 42, flags: ['a', 'b'] },
        artifacts: [{ path: 'artifacts/result.json', sha256: 'a'.repeat(64) }],
      }),
      JSON.stringify({ kind: 'p2p_script_machine_output_v1', displaySummary: 'done' }),
    ].join('\n'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frames).toHaveLength(2);
      expect(result.finalFrame.displaySummary).toBe('done');
      expect(result.frames[0]?.routingKey).toBe('accepted');
      expect(result.frames[0]?.variables).toEqual({ answer: 42, flags: ['a', 'b'] });
      expect(result.frames[0]?.artifacts?.[0]?.path).toBe('artifacts/result.json');
    }
  });

  it('defaults to lenient last-valid machine output parsing', () => {
    const result = parseP2pScriptMachineOutput([
      '{bad json',
      JSON.stringify({ kind: 'other', routingKey: 'ignored' }),
      JSON.stringify({ kind: 'p2p_script_machine_output_v1', routingKey: 'first' }),
      JSON.stringify({ kind: 'p2p_script_machine_output_v1', routingKey: 'final' }),
    ].join('\n'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frames.map((frame) => frame.routingKey)).toEqual(['first', 'final']);
      expect(result.finalFrame.routingKey).toBe('final');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'script_machine_output_invalid', severity: 'warning' }),
        expect.objectContaining({ code: 'script_machine_output_invalid', severity: 'warning' }),
      ]);
    }
  });

  it('preserves strict machine output parsing when requested', () => {
    const result = parseP2pScriptMachineOutput([
      JSON.stringify({ kind: 'p2p_script_machine_output_v1', routingKey: 'first' }),
      '{bad json',
    ].join('\n'), { mode: 'strict' });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({
      code: 'script_machine_output_invalid',
      severity: 'error',
    }));
  });

  it('enforces total and per-frame machine output byte caps', () => {
    expect(parseP2pScriptMachineOutput(
      JSON.stringify({ kind: 'p2p_script_machine_output_v1', displaySummary: 'x'.repeat(40) }),
      { maxFrameBytes: 16 },
    ).ok).toBe(false);

    expect(parseP2pScriptMachineOutput(
      `${JSON.stringify({ kind: 'p2p_script_machine_output_v1' })}\n${'x'.repeat(20)}`,
      { maxTotalBytes: 16 },
    ).ok).toBe(false);
  });

  it('rejects malformed and non-machine-output script frames', () => {
    expect(parseP2pScriptMachineOutput('plain text ROUTE=accepted').diagnostics[0]?.code).toBe('script_machine_output_invalid');
    expect(parseP2pScriptMachineOutput(JSON.stringify({ kind: 'other', routingKey: 'accepted' })).diagnostics[0]?.code).toBe('script_machine_output_invalid');
    expect(parseP2pScriptMachineOutput(JSON.stringify({
      kind: 'p2p_script_machine_output_v1',
      artifacts: [{ path: '../secret' }],
    })).diagnostics[0]?.code).toBe('script_machine_output_invalid');
    expect(parseP2pScriptMachineOutput(JSON.stringify({
      kind: 'p2p_script_machine_output_v1',
      variables: { nested: { nope: true } },
    })).diagnostics[0]?.code).toBe('script_machine_output_invalid');
  });

  it('rejects invalid contract environment and stdin caps', () => {
    expect(validateP2pScriptContract({ argv: ['node'], envAllowlist: ['bad-name'] }).ok).toBe(false);
    expect(validateP2pScriptContract({ argv: ['node'], stdin: 'hello', caps: { stdinBytes: 4 } }).ok).toBe(false);
  });

  // Audit:R3 PR-β / M-3 — lenient mode truncates at line boundary instead of
  // rejecting the entire output.
  it('lenient mode truncates at line boundary on total-bytes overflow and reports truncated:true', () => {
    const validFrame1 = JSON.stringify({ kind: 'p2p_script_machine_output_v1', routingKey: 'first' });
    const validFrame2 = JSON.stringify({ kind: 'p2p_script_machine_output_v1', routingKey: 'second' });
    const trailingFrame = JSON.stringify({ kind: 'p2p_script_machine_output_v1', routingKey: 'dropped' });
    const input = `${validFrame1}\n${validFrame2}\n${trailingFrame}\n`;
    // Cap allows the first two frames + their newline boundary, but cuts off
    // the trailing frame.
    const cap = validFrame1.length + 1 + validFrame2.length + 1;
    const result = parseP2pScriptMachineOutput(input, { mode: 'lenient_last_valid', maxTotalBytes: cap });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    if (result.ok) {
      expect(result.frames.map((frame) => frame.routingKey)).toEqual(['first', 'second']);
      expect(result.finalFrame.routingKey).toBe('second');
      // Truncation diagnostic is present at warning severity.
      expect(result.diagnostics.some((diagnostic) =>
        diagnostic.code === 'script_machine_output_invalid' && diagnostic.severity === 'warning',
      )).toBe(true);
    }
  });

  it('strict mode rejects total-bytes overflow without partial frames', () => {
    const validFrame = JSON.stringify({ kind: 'p2p_script_machine_output_v1', routingKey: 'ok' });
    const input = `${validFrame}\n${'x'.repeat(20)}`;
    const result = parseP2pScriptMachineOutput(input, { mode: 'strict', maxTotalBytes: validFrame.length });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'script_machine_output_invalid' && diagnostic.summary?.includes('total byte cap'),
    )).toBe(true);
  });
});
