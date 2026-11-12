import { describe, expect, it } from 'vitest';
import { AgyForegroundOwnership, NATIVE_OUTPUT_DEADLINE_MS } from '../../src/agent/agy-foreground-ownership.js';
import type { AgyTranscriptRow } from '../../src/agent/agy-transcript-bridge.js';
const row = (step: number, type: string, content: string, source = 'MODEL'): AgyTranscriptRow => ({step_index:step,type,content,source,status:'DONE'});
describe('AG captured native foreground ownership', () => {
  it('uses an extended default attribution deadline (45s-60s) for multi-step native turns', () => {
    expect(NATIVE_OUTPUT_DEADLINE_MS).toBeGreaterThanOrEqual(45_000);
    expect(NATIVE_OUTPUT_DEADLINE_MS).toBeLessThanOrEqual(60_000);
  });
  it('binds wrapped explicit inputs FIFO, not repeated output body or ACP arrival', async () => {
    const owner=new AgyForegroundOwnership();owner.register(1,'same user');owner.register(2,'same user');
    owner.observe(row(0,'USER_INPUT','wrapper same user tail','USER_EXPLICIT'));
    owner.observe(row(1,'PLANNER_RESPONSE','same answer'));
    owner.observe(row(2,'SYSTEM_MESSAGE','[Message] sender=child content=result'));
    owner.observe(row(3,'PLANNER_RESPONSE','same answer'));
    owner.observe(row(4,'USER_INPUT','wrapper same user tail','USER_EXPLICIT'));
    owner.observe(row(5,'PLANNER_RESPONSE','same answer'));
    expect((await owner.output(1))?.step_index).toBe(1);expect((await owner.output(2))?.step_index).toBe(5);
    expect(owner.latest?.generation).toBe(2);
  });
  it('does not bind summaries, foreign inputs, tools or reactive outputs to a foreground', async () => {
    const owner=new AgyForegroundOwnership(20);owner.register(1,'exact user payload');
    owner.observe(row(0,'USER_INPUT','exact user payload','SYSTEM'));
    owner.observe(row(1,'PLANNER_RESPONSE','unowned'));
    owner.observe(row(2,'USER_INPUT','foreign','USER_EXPLICIT'));
    owner.observe(row(3,'PLANNER_RESPONSE','foreign output'));
    expect(await owner.output(1)).toBeUndefined();
    owner.observe(row(4,'USER_INPUT','exact user payload','USER_EXPLICIT'));
    owner.observe({...row(5,'PLANNER_RESPONSE','tool'),tool_calls:[{name:'invoke_subagent'}]});
    owner.observe(row(6,'PLANNER_RESPONSE','owned'));expect((await owner.output(1))?.content).toBe('owned');
    owner.observe(row(7,'PLANNER_RESPONSE','unattributed duplicate'));expect((await owner.output(1))?.step_index).toBe(6);
  });
  it('waits for a native file event after the RPC boundary and releases on teardown',async()=>{
    const owner=new AgyForegroundOwnership(100);owner.register(1,'first');
    const pending=owner.output(1);owner.observe(row(0,'USER_INPUT','first','USER_EXPLICIT'));
    owner.observe(row(1,'PLANNER_RESPONSE','first result'));expect((await pending)?.content).toBe('first result');
    owner.register(2,'next');const cancelled=owner.output(2);owner.clear();expect(await cancelled).toBeUndefined();
    expect(owner.latest).toBeUndefined();owner.register(3,'next');owner.observe(row(2,'USER_INPUT','next','USER_EXPLICIT'));
    owner.observe(row(3,'PLANNER_RESPONSE','new owner'));expect((await owner.output(3))?.content).toBe('new owner');
  });
  it('retains active foreground lane across mid-turn peer SYSTEM_MESSAGE and multi-step tool calls', async () => {
    const owner = new AgyForegroundOwnership(100);
    owner.register(1, 'execute complex multi-step investigation');
    owner.observe(row(0, 'USER_INPUT', '<USER_REQUEST>\nexecute complex multi-step investigation\n</USER_REQUEST>', 'USER_EXPLICIT'));
    expect(owner.hasActiveLane()).toBe(true);
    owner.observe({ ...row(1, 'PLANNER_RESPONSE', 'step 1 tool'), tool_calls: [{ name: 'run_command' }] });
    owner.observe(row(2, 'SYSTEM_MESSAGE', '[Message] sender=subagent_a content=intermediate update'));
    expect(owner.hasActiveLane()).toBe(true);
    owner.observe({ ...row(3, 'PLANNER_RESPONSE', 'step 2 tool'), tool_calls: [{ name: 'read_file' }] });
    owner.observe(row(4, 'SYSTEM_MESSAGE', '[Message] sender=subagent_b content=second update'));
    expect(owner.hasActiveLane()).toBe(true);
    expect(owner.observe(row(5, 'PLANNER_RESPONSE', 'final synthesized foreground answer'))).toBe(true);
    expect(owner.hasActiveLane()).toBe(false);
    expect((await owner.output(1))?.content).toBe('final synthesized foreground answer');
    expect((await owner.output(1))?.step_index).toBe(5);
    // Subsequent reactive peer message after foreground settled must not overwrite prompt 1
    owner.observe(row(6, 'SYSTEM_MESSAGE', '[Message] sender=subagent_c content=post-turn wakeup'));
    expect(owner.observe(row(7, 'PLANNER_RESPONSE', 'reactive follow-up'))).toBe(false);
    expect((await owner.output(1))?.step_index).toBe(5);
  });
  it('matches normalized <USER_REQUEST> wrappers, CRLF newlines, and truncated long prompt prefixes', async () => {
    const owner = new AgyForegroundOwnership(50);
    owner.register(1, 'first line\r\nsecond   line\r\n\r\nthird line');
    owner.observe(row(0, 'USER_INPUT', '<USER_REQUEST>\nfirst line\nsecond line\nthird line\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>', 'USER_EXPLICIT'));
    owner.observe(row(1, 'PLANNER_RESPONSE', 'normalized match ok'));
    expect((await owner.output(1))?.content).toBe('normalized match ok');

    const longPrompt = 'Context instructions: '.repeat(6) + 'implement foreground ownership fix with full verification and tail marker XYZ-999';
    owner.register(2, longPrompt);
    const truncatedInLog = `<USER_REQUEST>\n${longPrompt.slice(0, 140)}...[truncated]\n</USER_REQUEST>`;
    owner.observe(row(2, 'USER_INPUT', truncatedInLog, 'USER_EXPLICIT'));
    owner.observe(row(3, 'PLANNER_RESPONSE', 'truncated prefix match ok'));
    expect((await owner.output(2))?.content).toBe('truncated prefix match ok');
  });
  it('does not mis-bind similar prefixes with divergent suffixes or ambiguous multiple pending prompts', async () => {
    const owner = new AgyForegroundOwnership(20);
    const sharedPrefix = 'Shared system context header block for agent session '.repeat(3); // > 150 chars
    owner.register(1, `${sharedPrefix} :: execute task ALPHA`);
    // Foreign input shares the 150+ char prefix but has a different suffix BETA
    owner.observe(row(0, 'USER_INPUT', `<USER_REQUEST>${sharedPrefix} :: execute task BETA</USER_REQUEST>`, 'USER_EXPLICIT'));
    owner.observe(row(1, 'PLANNER_RESPONSE', 'wrong beta output'));
    expect(await owner.output(1)).toBeUndefined();

    // Multiple pending prompts sharing the same prefix: truncated prefix is ambiguous and must not guess
    owner.register(2, `${sharedPrefix} :: execute task BETA`);
    owner.observe(row(2, 'USER_INPUT', `<USER_REQUEST>${sharedPrefix.slice(0, 120)}...</USER_REQUEST>`, 'USER_EXPLICIT'));
    owner.observe(row(3, 'PLANNER_RESPONSE', 'ambiguous output'));
    expect(await owner.output(1)).toBeUndefined();
    expect(await owner.output(2)).toBeUndefined();

    // Full input for BETA binds specifically to generation 2, not generation 1
    owner.observe(row(4, 'USER_INPUT', `<USER_REQUEST>${sharedPrefix} :: execute task BETA</USER_REQUEST>`, 'USER_EXPLICIT'));
    owner.observe(row(5, 'PLANNER_RESPONSE', 'exact beta output'));
    expect((await owner.output(2))?.content).toBe('exact beta output');
    expect(await owner.output(1)).toBeUndefined();
  });
  it('preserves literal <USER_REQUEST> tags inside outbound prompts, rejecting foreign quotes and incomplete wrappers while binding genuine wrapped inputs', async () => {
    const owner = new AgyForegroundOwnership(20);
    const example = '<USER_REQUEST>example payload</USER_REQUEST>';
    const promptText = `Fix the parser for the literal ${example}; preserve nested tags and add tests.`;
    owner.register(1, promptText);

    // 1. Foreign request quoting the same literal <USER_REQUEST> example must NOT bind
    owner.observe(row(0, 'USER_INPUT', `<USER_REQUEST>Explain the documentation for the literal ${example}; do not change the parser.</USER_REQUEST>`, 'USER_EXPLICIT'));
    owner.observe(row(1, 'PLANNER_RESPONSE', 'Foreign explanation, not the requested parser fix'));
    expect(await owner.output(1)).toBeUndefined();
    expect(owner.latest).toBeUndefined();

    // 2. Incomplete, unbalanced, or malformed outer wrappers must NOT bind
    for (const [idx, malformed] of [
      `<USER_REQUEST>${promptText}`,
      `${promptText}</USER_REQUEST>`,
      `<USER_REQUEST>outer <USER_REQUEST>inner</USER_REQUEST>`,
      `<USER_REQUEST>${promptText}</USER_REQUEST> unexpected trailing text`,
      `unexpected leading text <USER_REQUEST>${promptText}</USER_REQUEST>`,
    ].entries()) {
      owner.observe(row(2 + idx * 2, 'USER_INPUT', malformed, 'USER_EXPLICIT'));
      owner.observe(row(3 + idx * 2, 'PLANNER_RESPONSE', `malformed output ${idx}`));
    }
    expect(await owner.output(1)).toBeUndefined();
    expect(owner.latest).toBeUndefined();

    // 3. Genuine native outer wrapper around prompt containing literal <USER_REQUEST> tags (with CRLF + metadata) DOES bind
    owner.observe(
      row(
        20,
        'USER_INPUT',
        `<USER_REQUEST>\r\nFix the parser for the literal ${example};\r\npreserve nested tags and add tests.\r\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>`,
        'USER_EXPLICIT',
      ),
    );
    expect(owner.observe(row(21, 'PLANNER_RESPONSE', 'Owned parser fix with nested literal tag'))).toBe(true);
    expect((await owner.output(1))?.content).toBe('Owned parser fix with nested literal tag');
    expect(owner.latest?.generation).toBe(1);

    // 4. Plain (unwrapped) exact/whitespace-normalized and wrapped USER_EXPLICIT inputs containing inline or full literal <USER_REQUEST> tags bind FIFO
    const wholeTagPayload = '<USER_REQUEST>this is the complete literal user payload</USER_REQUEST>';
    owner.register(2, promptText);
    owner.register(3, wholeTagPayload);
    owner.register(4, wholeTagPayload);
    owner.register(5, wholeTagPayload);
    owner.observe(row(22, 'USER_INPUT', promptText, 'USER_EXPLICIT'));
    owner.observe(row(23, 'PLANNER_RESPONSE', 'plain inline tag answer'));
    owner.observe(row(24, 'USER_INPUT', wholeTagPayload, 'USER_EXPLICIT'));
    owner.observe(row(25, 'PLANNER_RESPONSE', 'plain whole tag answer 1'));
    owner.observe(row(26, 'USER_INPUT', '<USER_REQUEST>this is the complete\r\n  literal user payload</USER_REQUEST>', 'USER_EXPLICIT'));
    owner.observe(row(27, 'PLANNER_RESPONSE', 'plain whole tag answer 2'));
    owner.observe(row(28, 'USER_INPUT', `<USER_REQUEST>\r\n${wholeTagPayload}\r\n</USER_REQUEST>`, 'USER_EXPLICIT'));
    owner.observe(row(29, 'PLANNER_RESPONSE', 'wrapped whole tag answer 3'));
    expect((await owner.output(2))?.content).toBe('plain inline tag answer');
    expect((await owner.output(3))?.content).toBe('plain whole tag answer 1');
    expect((await owner.output(4))?.content).toBe('plain whole tag answer 2');
    expect((await owner.output(5))?.content).toBe('wrapped whole tag answer 3');
    expect(owner.latest?.generation).toBe(5);
  });
  it('clears active lane on release after timeout so late native output cannot pollute the next turn', async () => {
    const owner = new AgyForegroundOwnership(20);
    owner.register(1, 'turn one payload');
    owner.observe(row(0, 'USER_INPUT', 'turn one payload', 'USER_EXPLICIT'));
    expect(owner.hasActiveLane()).toBe(true);
    expect(await owner.output(1)).toBeUndefined();
    owner.release(1);
    expect(owner.hasActiveLane()).toBe(false);
    // Late PLANNER_RESPONSE from timed-out turn 1 arrives after release(1)
    expect(owner.observe(row(1, 'PLANNER_RESPONSE', 'late turn one output'))).toBe(false);
    expect(owner.latest).toBeUndefined();

    // Turn 2 proceeds cleanly without pollution from turn 1
    owner.register(2, 'turn two payload');
    owner.observe(row(2, 'USER_INPUT', 'turn two payload', 'USER_EXPLICIT'));
    expect(owner.observe(row(3, 'PLANNER_RESPONSE', 'turn two output'))).toBe(true);
    expect((await owner.output(2))?.content).toBe('turn two output');
    expect(owner.latest?.generation).toBe(2);
  });
  it('attributes foreground output via settle() when turn ends with a PLANNER_RESPONSE containing tool_calls', async () => {
    const owner = new AgyForegroundOwnership(60_000);
    owner.register(1, 'ask user question payload');
    owner.observe(row(0, 'USER_INPUT', '<USER_REQUEST>ask user question payload</USER_REQUEST>', 'USER_EXPLICIT'));
    expect(owner.hasActiveLane()).toBe(true);
    owner.observe({
      ...row(1, 'PLANNER_RESPONSE', 'Which option do you prefer?'),
      tool_calls: [{ name: 'ask_question', args: { question: 'Pick one' } }],
    });
    // Explicit settle() attributes the lastResponse immediately without waiting for 60s timeout
    const settled = owner.settle(1);
    expect(settled?.content).toBe('Which option do you prefer?');
    expect(settled?.step_index).toBe(1);
    const out = await owner.output(1);
    expect(out?.content).toBe('Which option do you prefer?');
    expect(out?.step_index).toBe(1);
    expect(owner.latest?.generation).toBe(1);
    expect(owner.latest?.row.content).toBe('Which option do you prefer?');
    expect(owner.hasActiveLane()).toBe(false);
  });
  it('falls back to lastResponse on output() deadline if settle() was not called', async () => {
    const owner = new AgyForegroundOwnership(20);
    owner.register(1, 'ask user question payload');
    owner.observe(row(0, 'USER_INPUT', '<USER_REQUEST>ask user question payload</USER_REQUEST>', 'USER_EXPLICIT'));
    expect(owner.hasActiveLane()).toBe(true);
    owner.observe({
      ...row(1, 'PLANNER_RESPONSE', 'Fallback question text'),
      tool_calls: [{ name: 'ask_question', args: { question: 'Pick one' } }],
    });
    // On base, output(1) would return undefined after timeout.
    // With fix, it falls back to lastResponse after timeout.
    const out = await owner.output(1);
    expect(out?.content).toBe('Fallback question text');
    expect(out?.step_index).toBe(1);
    expect(owner.latest?.generation).toBe(1);
    expect(owner.latest?.row.content).toBe('Fallback question text');
    expect(owner.hasActiveLane()).toBe(false);
  });
  it('retains the final tool_call response across multi-step intermediate tool calls when settling', async () => {
    const owner = new AgyForegroundOwnership(60_000);
    owner.register(1, 'investigate and ask');
    owner.observe(row(0, 'USER_INPUT', '<USER_REQUEST>investigate and ask</USER_REQUEST>', 'USER_EXPLICIT'));
    // Step 1: intermediate tool call (e.g. read_file)
    owner.observe({
      ...row(1, 'PLANNER_RESPONSE', 'reading config'),
      tool_calls: [{ name: 'read_file', args: { Path: '/etc/cfg' } }],
    });
    expect(owner.hasActiveLane()).toBe(true);
    // Step 2: intermediate peer message
    owner.observe(row(2, 'SYSTEM_MESSAGE', '[Message] sender=peer content=note'));
    expect(owner.hasActiveLane()).toBe(true);
    // Step 3: final tool call ending the turn (e.g. ask_question)
    owner.observe({
      ...row(3, 'PLANNER_RESPONSE', 'Do you want to proceed with this config?'),
      tool_calls: [{ name: 'ask_question', args: { question: 'Proceed?' } }],
    });
    expect(owner.hasActiveLane()).toBe(true);
    // Turn finishes, settle attributes step 3, NOT step 1
    const settled = owner.settle(1);
    expect(settled?.step_index).toBe(3);
    expect(settled?.content).toBe('Do you want to proceed with this config?');
    const out = await owner.output(1);
    expect(out?.step_index).toBe(3);
    expect(owner.latest?.generation).toBe(1);
    expect(owner.latest?.row.step_index).toBe(3);
    expect(owner.hasActiveLane()).toBe(false);

    // Repeated settle is idempotent
    expect(owner.settle(1)?.step_index).toBe(3);
    // Settle on non-existent generation is safe
    expect(owner.settle(99)).toBeUndefined();
  });
  it('does not overwrite pure text output with settle() and preserves pure text behavior', async () => {
    const owner = new AgyForegroundOwnership(60_000);
    owner.register(1, 'pure text prompt');
    owner.observe(row(0, 'USER_INPUT', '<USER_REQUEST>pure text prompt</USER_REQUEST>', 'USER_EXPLICIT'));
    owner.observe({
      ...row(1, 'PLANNER_RESPONSE', 'intermediate tool'),
      tool_calls: [{ name: 'run_command' }],
    });
    // Pure text response arrives
    expect(owner.observe(row(2, 'PLANNER_RESPONSE', 'final pure text answer'))).toBe(true);
    expect(owner.hasActiveLane()).toBe(false);
    // Settle afterwards does not modify or corrupt the already resolved pure text
    const settled = owner.settle(1);
    expect(settled?.content).toBe('final pure text answer');
    expect(settled?.step_index).toBe(2);
    expect((await owner.output(1))?.content).toBe('final pure text answer');
  });
  it('does not attribute intermediate subagent tool calls (empty or non-empty content) on settle()', async () => {
    const owner = new AgyForegroundOwnership(60_000);
    owner.register(1, 'launch background worker');
    owner.observe(row(0, 'USER_INPUT', '<USER_REQUEST>launch background worker</USER_REQUEST>', 'USER_EXPLICIT'));
    // Step 1: subagent tool call with non-empty commentary (e.g. invoke_subagent with 'Launching worker')
    owner.observe({
      ...row(1, 'PLANNER_RESPONSE', 'Launching worker'),
      tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Child' } }],
    });
    // settle(1) should not attribute the subagent tool call
    expect(owner.settle(1)).toBeUndefined();
    expect(owner.latest).toBeUndefined();
    expect(owner.hasActiveLane()).toBe(true);

    // Later arriving pure text settles correctly
    owner.observe(row(2, 'PLANNER_RESPONSE', 'PARENT-STARTED'));
    expect(owner.settle(1)?.content).toBe('PARENT-STARTED');
    expect((await owner.output(1))?.content).toBe('PARENT-STARTED');
    expect(owner.hasActiveLane()).toBe(false);
  });
  it('attributes foreground output via settle() even when final ask_question has empty content', async () => {
    const owner = new AgyForegroundOwnership(60_000);
    owner.register(1, 'confirm action');
    owner.observe(row(0, 'USER_INPUT', '<USER_REQUEST>confirm action</USER_REQUEST>', 'USER_EXPLICIT'));
    // Step 1: terminal ask_question with empty content
    owner.observe({
      ...row(1, 'PLANNER_RESPONSE', ''),
      tool_calls: [{ name: 'ask_question', args: { question: 'Confirm?' } }],
    });
    const settled = owner.settle(1);
    expect(settled).toBeDefined();
    expect(settled?.content).toBe('');
    expect(settled?.step_index).toBe(1);
    expect((await owner.output(1))?.step_index).toBe(1);
    expect(owner.hasActiveLane()).toBe(false);
  });
  it('does not attribute intermediate execution tools with empty content on settle()', async () => {
    const owner = new AgyForegroundOwnership(60_000);
    owner.register(1, 'read file prompt');
    owner.observe(row(0, 'USER_INPUT', '<USER_REQUEST>read file prompt</USER_REQUEST>', 'USER_EXPLICIT'));
    // Step 1: execution tool call with empty content (e.g. read_file)
    owner.observe({
      ...row(1, 'PLANNER_RESPONSE', ''),
      tool_calls: [{ name: 'read_file', args: { Path: '/tmp/test' } }],
    });
    // settle(1) should not attribute empty execution tool call
    expect(owner.settle(1)).toBeUndefined();
    expect(owner.latest).toBeUndefined();
    expect(owner.hasActiveLane()).toBe(true);

    // Later arriving pure text settles correctly
    owner.observe(row(2, 'PLANNER_RESPONSE', 'file content read'));
    expect(owner.settle(1)?.content).toBe('file content read');
    expect((await owner.output(1))?.content).toBe('file content read');
    expect(owner.hasActiveLane()).toBe(false);
  });
});
