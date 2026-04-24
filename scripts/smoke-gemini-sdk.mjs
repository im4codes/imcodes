// Smoke test: drive the GeminiSdkProvider directly against `gemini --acp`.
// Run from repo root with: npx tsx scripts/smoke-gemini-sdk.mjs
import { GeminiSdkProvider } from '../src/agent/providers/gemini-sdk.ts';

const provider = new GeminiSdkProvider();
let sawComplete = false;
let resumeId = null;
const deltas = [];
const tools = [];

provider.onDelta((sid, d) => deltas.push({ sid, len: d.delta.length }));
provider.onComplete((sid, msg) => {
  sawComplete = true;
  console.log('[COMPLETE]', sid, 'text=' + JSON.stringify(msg.content.slice(0, 140)));
  if (msg.metadata?.resumeId) resumeId = msg.metadata.resumeId;
});
provider.onError((sid, err) => console.log('[ERROR]', sid, err.code, err.message));
provider.onToolCall((sid, tool) => tools.push({ sid, name: tool.name, status: tool.status }));
provider.onSessionInfo((sid, info) => {
  if (info.resumeId) resumeId ??= info.resumeId;
  console.log('[INFO]', sid, JSON.stringify(info));
});
provider.onStatus((sid, s) => console.log('[STATUS]', sid, s.status, s.label));

console.log('Phase 1: connect + createSession + send');
await provider.connect({});
await provider.createSession({ sessionKey: 'smoke-1', cwd: '/home/k/codedeck/codedeck' });

await provider.send('smoke-1', 'Please remember the secret code ZR-MANGO-31. Reply OK only.');
const t0 = Date.now();
while (!sawComplete && Date.now() - t0 < 45000) await new Promise((r) => setTimeout(r, 200));
if (!sawComplete) { console.log('TIMEOUT phase 1'); process.exit(1); }
console.log('deltas=', deltas.length, 'tools=', tools.length);

await provider.disconnect();
console.log('disconnected');

if (!resumeId) { console.log('no resumeId captured'); process.exit(1); }

console.log('\nPhase 2: reconnect + resume');
const provider2 = new GeminiSdkProvider();
let sawComplete2 = false;
let recallText = '';
provider2.onComplete((_sid, msg) => { sawComplete2 = true; recallText = msg.content; console.log('[COMPLETE2]', msg.content.slice(0, 140)); });
provider2.onError((_sid, err) => console.log('[ERROR2]', err.code, err.message));

await provider2.connect({});
await provider2.createSession({ sessionKey: 'smoke-1', cwd: '/home/k/codedeck/codedeck', resumeId });
await provider2.send('smoke-1', 'What secret code did I tell you?');
const t1 = Date.now();
while (!sawComplete2 && Date.now() - t1 < 45000) await new Promise((r) => setTimeout(r, 200));
await provider2.disconnect();

console.log('\nRESULT');
console.log('  phase1.resumeId=', resumeId);
console.log('  phase2.recallText=', JSON.stringify(recallText.slice(0, 240)));
console.log('  recall-contains-ZR-MANGO-31?', /ZR-MANGO-31/.test(recallText));
process.exit(sawComplete2 && /ZR-MANGO-31/.test(recallText) ? 0 : 1);
