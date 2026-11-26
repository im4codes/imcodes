import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgyCompactionWatermark } from '../../src/agent/agy-compaction-watermark.js';
import { AgyContextUsage } from '../../src/agent/agy-context-usage.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, {recursive:true, force:true}))); });
const row = (index: number, type = 'USER_INPUT') => JSON.stringify({step_index:index, type, status:'DONE', source:'USER_EXPLICIT', created_at:`2026-11-12T00:00:${index}Z`, content:'<CONTEXT_SUMMARY> 摘要😀 </CONTEXT_SUMMARY>'})+'\n';
describe('AG compaction watermark and current context', () => {
  it('only reasserts once for each real user summary, including append, partial UTF8 and rotation', async () => {
    const home=await mkdtemp(path.join(tmpdir(),'imcodes-ag-context-')); roots.push(home);
    const logs=path.join(home,'.gemini/antigravity-cli/brain/native-fixture/.system_generated/logs');
    await mkdir(logs,{recursive:true}); const file=path.join(logs,'transcript.jsonl');
    const reader=new AgyCompactionWatermark();
    expect(await reader.check(home,'native-fixture')).toBe(false);
    await writeFile(file,row(1,'PLANNER_RESPONSE'));
    expect(await reader.check(home,'native-fixture')).toBe(false);
    await appendFile(file,row(2));
    expect(await reader.check(home,'native-fixture')).toBe(true);
    expect(reader.summaryTokens).toBeGreaterThan(0);
    expect(await reader.check(home,'native-fixture')).toBe(false);
    await appendFile(file,JSON.stringify({step_index:3,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',created_at:'later',content:'ordinary text mentioning <CONTEXT_SUMMARY>'})+'\n');
    expect(await reader.check(home,'native-fixture')).toBe(false);
    const next=Buffer.from(row(4));const split=next.indexOf(Buffer.from('😀'))+2;
    await appendFile(file,next.subarray(0,split)); expect(await reader.check(home,'native-fixture')).toBe(false);
    await appendFile(file,next.subarray(split)); expect(await reader.check(home,'native-fixture')).toBe(true);
    await rename(file,file+'.old'); await writeFile(file,row(2)+row(4));
    expect(await reader.check(home,'native-fixture')).toBe(false);
    await appendFile(file,row(5)); expect(await reader.check(home,'native-fixture')).toBe(true);
    await appendFile(file,JSON.stringify({step_index:6,type:'CHECKPOINT',source:'SYSTEM',status:'DONE',created_at:'new',content:'# Resuming from a compaction\nFull checkpoint summary'})+'\n');
    expect(await reader.check(home,'native-fixture')).toBe(true);
    expect(await reader.check(home,'native-fixture')).toBe(false);
    expect(await reader.check(home,'../outside')).toBe(false);
  });
  it('uses native used/size over billing fields, handles compaction shrink and never turns known content into zero', () => {
    const meter=new AgyContextUsage(); meter.beginPrompt('system and identity '.repeat(50));
    expect(meter.normalize({inputTokens:0,outputTokens:2})).toMatchObject({context_usage_estimated:true});
    expect(Number(meter.normalize().input_tokens)).toBeGreaterThan(10);
    expect(meter.normalize({used:45000,size:1000000})).toMatchObject({input_tokens:45000,model_context_window:1000000});
    expect(meter.normalize({inputTokens:10,outputTokens:5})).toMatchObject({input_tokens:45000,output_tokens:5});
    meter.resetToSummary(50); meter.beginPrompt('Full restored system text');
    const after=meter.normalize({input_tokens:0}); expect(after.input_tokens).toBeGreaterThan(50); expect(after.input_tokens).toBeLessThan(45000);
    expect(after.context_usage_estimated).toBe(true);
    expect(meter.normalize({inputTokens:120,cachedReadTokens:30})).toMatchObject({input_tokens:120,cache_read_input_tokens:30});
    expect(meter.normalize({inputTokens:NaN,outputTokens:Infinity}).input_tokens).toBeGreaterThan(0);
  });

  it('tracks whether a compaction was superseded by a subsequent PLANNER_RESPONSE', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'imcodes-ag-watermark-post-')); roots.push(home);
    const logs = path.join(home, '.gemini/antigravity-cli/brain/post-compaction/.system_generated/logs');
    await mkdir(logs, { recursive: true });
    const file = path.join(logs, 'transcript.jsonl');
    await writeFile(file, [
      JSON.stringify({ step_index: 2748, type: 'CHECKPOINT', source: 'SYSTEM', status: 'DONE', created_at: '2026-11-12T00:00:01Z', content: '# Resuming from a compaction\n' + 'x'.repeat(3900) }),
      JSON.stringify({ step_index: 2835, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T00:01:00Z', content: 'after compaction reply' }),
    ].join('\n') + '\n');

    const reader = new AgyCompactionWatermark();
    expect(await reader.check(home, 'post-compaction')).toBe(true);
    expect(reader.compactionStepIndex).toBe(2748);
    expect(reader.hasPostCompactionPlannerResponse).toBe(true);

    // A newer compaction with no subsequent PLANNER_RESPONSE clears the flag.
    await appendFile(file, JSON.stringify({ step_index: 2900, type: 'CHECKPOINT', source: 'SYSTEM', status: 'DONE', created_at: '2026-11-12T00:02:00Z', content: '# Resuming from a compaction\nfresh' }) + '\n');
    expect(await reader.check(home, 'post-compaction')).toBe(true);
    expect(reader.compactionStepIndex).toBe(2900);
    expect(reader.hasPostCompactionPlannerResponse).toBe(false);

    await appendFile(file, JSON.stringify({ step_index: 2901, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T00:02:10Z', content: 'post new compaction' }) + '\n');
    expect(await reader.check(home, 'post-compaction')).toBe(false);
    expect(reader.hasPostCompactionPlannerResponse).toBe(true);
  });

  it('preserves native (input, cache) split across incremental empty normalize() and beginPrompt() calls', () => {
    const meter = new AgyContextUsage();
    const seeded = meter.normalize({ input_tokens: 3324, cache_read_tokens: 209320, output_tokens: 180 });
    expect(seeded).toEqual({ input_tokens: 3324, cache_read_input_tokens: 209320, output_tokens: 180 });

    meter.beginPrompt('next user prompt '.repeat(10));
    const afterPrompt = meter.normalize({});
    expect(afterPrompt.cache_read_input_tokens).toBe(209320);
    expect(afterPrompt.input_tokens).toBeGreaterThan(3324);
    expect(afterPrompt.context_usage_estimated).toBeUndefined();

    // Even zeroed billing input must not wipe native cache tokens.
    const afterEmptyRaw = meter.normalize({ inputTokens: 0 });
    expect(afterEmptyRaw.cache_read_input_tokens).toBe(209320);
    expect(afterEmptyRaw.input_tokens).toBeGreaterThanOrEqual(afterPrompt.input_tokens!);

    // Fresh compaction resets back to estimated summary count.
    meter.resetToSummary(950);
    meter.beginPrompt('fresh prompt');
    const postCompact = meter.normalize({});
    expect(postCompact.cache_read_input_tokens).toBe(0);
    expect(postCompact.context_usage_estimated).toBe(true);
    expect(postCompact.input_tokens).toBeGreaterThan(950);
    expect(postCompact.input_tokens).toBeLessThan(2000);
  });
});
