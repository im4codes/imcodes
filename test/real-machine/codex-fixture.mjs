#!/usr/bin/env node
// Minimal deterministic Codex protocol fixture. It is intentionally transport-agnostic:
// pipe JSONL to stdin and receive matching JSONL responses, suitable for load tests.
import readline from 'node:readline';
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{try{const msg=JSON.parse(line); process.stdout.write(JSON.stringify({id:msg.id??null,result:{ok:true,echo:msg.method??null}})+'\n')}catch(e){process.stdout.write(JSON.stringify({error:String(e)})+'\n')}});
