import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** Absolute, credential-free SDK child shared by AG persistence/manager tests. */
export function writeAgyNativeChildFixture(home: string, options: { controlledTurns?: boolean } = {}): string {
  const bin=path.join(home,'agy-fixture');
  writeFileSync(bin,`#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--help')) process.exit(0);
const a=process.argv;const i=a.indexOf('--conversation');const id=i<0?require('node:crypto').randomUUID():a[i+1];
fs.appendFileSync(process.env.HOME+'/launches',JSON.stringify({id,resumed:i>=0})+'\\n');
fs.appendFileSync(process.env.HOME+'/models',JSON.stringify(a[a.indexOf('--model')+1])+'\\n');
const emit=o=>process.stdout.write(JSON.stringify(o)+'\\n');
emit({event:'init',conversation_id:id});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 fs.appendFileSync(process.env.HOME+'/inputs',line+'\\n');
 const finish=()=>emit({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'ok'}});
 if (${!!options.controlledTurns} && line.includes('fixture-hold')) {
  const timer=setInterval(()=>{if(fs.existsSync(process.env.HOME+'/release')){clearInterval(timer);finish();}},5);
 } else finish();
});
`,{mode:0o700});
  writeFileSync(path.join(home,'launches'),''); writeFileSync(path.join(home,'inputs'),''); writeFileSync(path.join(home,'models'),'');
  return bin;
}
