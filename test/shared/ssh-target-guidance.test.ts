import { describe, expect, it } from 'vitest';
import { SSH_TARGET_ROUTING_GUIDANCE as rule } from '../../shared/ssh-target-guidance.js';
import { REAL_DEVICE_AUTHORIZATION_GUIDANCE, REAL_DEVICE_TESTING_SYSTEM_GUIDANCE } from '../../shared/transport-runtime-prompts.js';
import { buildTaskPairMarkerContract, TASK_PAIR_SELF_SUFFICIENCY_RULE } from '../../shared/task-pair.js';
import { ALIAS_MCP_TOOLS } from '../../shared/alias-types.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { VERIFICATION_MACHINE_MCP_TOOLS } from '../../shared/verification-machine.js';

describe('canonical SSH target routing contract', () => {
  it('ships the same complete rule once in each standalone generated contract', () => {
    for (const text of [REAL_DEVICE_AUTHORIZATION_GUIDANCE, REAL_DEVICE_TESTING_SYSTEM_GUIDANCE, TASK_PAIR_SELF_SUFFICIENCY_RULE, buildTaskPairMarkerContract()]) {
      expect(text).toContain(rule);
      expect(text.split(rule)).toHaveLength(2);
    }
  });
  it('distinguishes supplied literal targets from aliases without reauthorization or alias loops', () => {
    expect(rule).toContain('SSH command or literal SSH host/port/IdentityFile');
    expect(rule).toContain('use SSH directly to that exact authorized target');
    expect(rule).toContain(`Only a user-supplied SSH alias needs ${ALIAS_MCP_TOOLS.RESOLVE}, once`);
    expect(rule).toContain('a literal target does not need alias resolution or a second authorization');
    expect(rule).toContain('An unknown alias must not block an already supplied literal SSH target');
    expect(REAL_DEVICE_AUTHORIZATION_GUIDANCE).not.toContain('for an ssh target resolve its alias');
  });
  it('forbids guessed channel sweeps and control-plane waiting, not a proven available OCU choice', () => {
    expect(rule).toContain('do not first enumerate verification machines or cycle through OCU/computer-use');
    expect(rule).toContain('do not wait or poll for control-plane recovery');
    expect(rule).toContain('OCU may be chosen only when you clearly know that the specific target and required OCU function are available');
    expect(rule).toContain('a listed tool or generic online status is not proof');
    expect(rule).toContain('an explicit user statement, prior success for that same target/function');
    expect(rule).toContain('SSH failure alone is not evidence of OCU availability');
    expect(rule).toContain('original tool schema, authority and resource claims');
    expect(rule).not.toMatch(/never (?:use|choose) OCU|OCU is forbidden/);
    expect(rule).toContain('Local shell use to run the SSH client and isolated local development/unit/SDK tests remains allowed');
    expect(rule).toContain('A separate explicit user request for GUI or another channel still governs that work');
  });
  it('bounds failed preflight and removes a conflicting mandatory alternative sweep', () => {
    expect(rule).toContain('Run a bounded SSH preflight');
    expect(rule).toContain('stop repeated retries of the same failure');
    expect(rule).toContain('Continue work independent of that target');
    expect(rule).toContain('ask once with precise options');
    expect(TASK_PAIR_SELF_SUFFICIENCY_RULE).toContain('When no SSH target was supplied and an authorized tool or channel fails');
    expect(TASK_PAIR_SELF_SUFFICIENCY_RULE).not.toContain('When a tool or channel fails, switch');
    expect(TASK_PAIR_SELF_SUFFICIENCY_RULE).not.toContain('the alternatives already tried.');
  });
  it('keeps controlled-node, no-target discovery and destructive-work safeguards', () => {
    expect(REAL_DEVICE_AUTHORIZATION_GUIDANCE).toContain(`controlled_node use ${MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE} with its nodeId`);
    expect(REAL_DEVICE_AUTHORIZATION_GUIDANCE).toContain(`When the user has not specified a target, call ${VERIFICATION_MACHINE_MCP_TOOLS.LIST}`);
    expect(REAL_DEVICE_AUTHORIZATION_GUIDANCE).toContain(VERIFICATION_MACHINE_MCP_TOOLS.VERIFY);
    expect(REAL_DEVICE_AUTHORIZATION_GUIDANCE).toContain('requires confirmation of the precise scope');
    expect(rule).toContain('disable host-key verification, guess a nodeId, or bypass resource claims, credential checks, tool authority');
    expect(rule).toContain('With no supplied SSH target, keep the existing controlled-node and no-target discovery rules');
  });
  it('is generic prose, not a baked-in target, credential or machine-specific rule', () => {
    expect(rule).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b|ai@|ESXi|BEGIN .*PRIVATE KEY|StrictHostKeyChecking=no/);
    expect(rule.length).toBeLessThan(3000);
  });
});
