#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import process from 'node:process';
const a=process.argv.slice(2); const get=(k,d='')=>{const i=a.indexOf(k); return i<0?d:a[i+1]??d};
const base=get('--base').replace(/\/$/,''); const serverId=get('--server-id'); const session=get('--session'); const sendUrl=get('--send-url',`${base}/api/server/${serverId}/session/send`); const historyUrl=get('--history-url',`${base}/api/server/${serverId}/timeline/history?sessionName=${encodeURIComponent(session)}`); const token=get('--token'); const serverToken=get('--server-token'); const rounds=Number(get('--rounds','1')); const pid=Number(get('--pid','0')); if(!token && !serverToken) throw new Error('--token or --server-token required'); const headers={'content-type':'application/json',authorization:`Bearer ${serverToken ?? token}`,...(serverToken ? {'x-server-id':serverId} : {})}; const historyHeaders=token ? {'content-type':'application/json',authorization:`Bearer ${token}`} : headers;
if(!base) throw new Error('--base required');
const samples=[]; const timer=setInterval(()=>{if(pid&&process.platform==='linux'){try{samples.push(fs.readFileSync(`/proc/${pid}/status`,'utf8').split('\n').filter(x=>/^VmRSS|^Threads:/.test(x)).join(' '))}catch{}} else samples.push(`${Date.now()} ${os.loadavg().join(',')}`)},1000);
for(let i=0;i<rounds;i++){const r=await fetch(sendUrl,{method:'POST',headers,body:JSON.stringify({sessionName:session,message:`real-machine-kit round ${i}`,text:`real-machine-kit round ${i}`})}); if(!r.ok) throw new Error(`send ${r.status}: ${await r.text()}`); const h=await fetch(historyUrl,{headers:historyHeaders}); if(!h.ok) throw new Error(`history ${h.status}: ${await h.text()}`); console.log(JSON.stringify({round:i,send:r.status,history:h.status}));}
clearInterval(timer); console.log(JSON.stringify({samples}));
