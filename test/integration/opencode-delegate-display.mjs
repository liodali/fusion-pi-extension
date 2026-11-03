// Model-free visual fixture: mounts the real Fusion TUI widget in OpenCode's
// terminal, supplies a deterministic session-local activity feed, and checks
// live rendering, stop-button dispatch, and completed rendering. Backend event routing is tested separately in
// opencode-plugin.test.ts. No prompts, credentials, or model requests.
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeArtifact } from "./artifact.mjs";
import { spawn as spawnServer, spawnSync } from "node:child_process";
import { Terminal as Screen } from "@xterm/headless";

const repo = resolve(import.meta.dirname, "../..");
const root = await mkdtemp(join(tmpdir(), "fusion-delegate-display-"));
let packageRoot = repo;
if (process.env.FUSION_OPENCODE_TARBALL) {
 await cp(process.env.FUSION_OPENCODE_TARBALL,join(root,'fusion-opencode.tgz'));
 await writeFile(join(root,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'fusion-opencode':'file:./fusion-opencode.tgz'}}));
 const installed=spawnSync('bun',['install'],{cwd:root,encoding:'utf8'});
 assert.equal(installed.status,0,'Dedicated package consumer must install');
 packageRoot=join(root,'node_modules/fusion-opencode');
}
const driver = join(root, "driver");
await mkdir(driver);
await mkdir(join(root, "home"));
await writeFile(join(driver, "package.json"), JSON.stringify({ name: "fusion-display-fixture", type: "module", exports: { ".": "./index.ts", "./tui": "./tui.tsx" } }));
await writeFile(join(driver, "index.ts"), `export default {id:'fusion-display-fixture',async setup(ctx){

}};`);
await writeFile(join(driver, "tui.tsx"), `
import {writeFileSync} from 'node:fs';
export default {id:'fusion-display-fixture',async setup(ctx){
 try {
 const {createSignal}=await import('solid-js');
 const {default:fusion}=await import(${JSON.stringify(join(packageRoot, "src/opencode/tui.ts"))});
 const [done,setDone]=createSignal(false);
 const [stopped,setStopped]=createSignal(false);
 const startedAt=Date.now()-2000;
 const messages=()=>[{type:'assistant',content:[{type:'tool',name:'fusion_delegate',time:{created:startedAt},state:{
 status:done()?'completed':'running',input:{action:'execute',title:'Implement object operations',details:{brief:'LONG_BRIEF_SHOULD_STAY_COLLAPSED '.repeat(500)}},
 metadata:{fusion:{version:1,action:'execute',title:'Implement object operations',phase:done()?'completed':'working',activity:done()?'Ready for supervisor review':'Running edit',tools:done()?7:3,startedAt,updatedAt:Date.now(),childSessionID:'ses_fixture_executor',requestId:'req_fixture'}}}}]},
 ...(stopped()&&!done()?[{type:'synthetic',metadata:{fusionStop:{requestId:'req_fixture',requestedAt:startedAt,updatedAt:Date.now(),state:'acknowledged',reason:'Stop button'}}}]:[])];
 const cleanup=fusion.setup({...ctx,client:{...ctx.client,session:{...ctx.client.session,command:async(input)=>{writeFileSync(${JSON.stringify(join(root, 'stop-command.json'))},JSON.stringify(input));setStopped(true);setTimeout(()=>setDone(true),1500);}}},data:{...ctx.data,session:{...ctx.data.session,message:{...ctx.data.session.message,list:messages}}}});
 const timer=setTimeout(()=>setDone(true),20000);
 return ()=>{clearTimeout(timer);cleanup();};
 }catch(error){writeFileSync(${JSON.stringify(join(root, 'driver-error.txt'))},String(error?.stack??error));throw error;}
}};
`);
await writeFile(join(root, "opencode.json"), JSON.stringify({ plugins: [packageRoot, driver] }));
const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
env.HOME = join(root, "home");
env.TERM = "xterm-256color";
env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
for (const key of ["DATA", "CONFIG", "CACHE", "STATE"]) env[`XDG_${key}_HOME`] = join(root, key);
let output = "";
const decoder = new TextDecoder();
const screen = new Screen({ cols: 120, rows: 32, scrollback: 500, allowProposedApi: true });
let screenWrites = Promise.resolve();
let terminal, child;
const server=spawnServer(process.env.FUSION_OPENCODE_BIN || "opencode",['serve','--hostname','127.0.0.1','--port','0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
let serverLog='';
for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{serverLog+=chunk.toString()});
const result = { ok: false, modelFree: true, fixtureFeed: true, installedPackage:packageRoot!==repo };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = () => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
const frame = () => Array.from({length:screen.rows},(_,i)=>screen.buffer.active.getLine(screen.buffer.active.viewportY+i)?.translateToString()??'').join('\n');
try {
 let url,password;
 for(let i=0;i<300;i++) {
  url=serverLog.match(/server listening on (http:\/\/\S+)/)?.[1];
  password=serverLog.match(/server password (\S+)/)?.[1];
  if(url&&password)break;
  if(server.exitCode!==null)throw Error('Private server exited during startup');
  await delay(100);
 }
 assert.ok(url&&password,'Private server must announce readiness');
 const headers={authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64'),'content-type':'application/json'};
 const api=async(path,body)=>{
  let response;
  for(let attempt=0;attempt<100;attempt++) {
   response=await fetch(url+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
   if(body || response.status!==503)break;
   await response.arrayBuffer();await delay(100);
  }
  assert.ok(response.ok,`API ${path} returned ${response.status}: ${response.ok?'':(await response.text()).slice(0,400)}`);
  return response.json();
 };
 await api('/api/agent');
 const created=await api('/api/session',{title:'Fusion activity display fixture'});
 const sessionID=created.id??created.data?.id;
 assert.ok(typeof sessionID==='string'&&sessionID.startsWith('ses_'),'Session must exist before TUI attachment');
 env.OPENCODE_PASSWORD=password;
 terminal = new Bun.Terminal({cols:120,rows:32,data(_terminal,bytes){output+=decoder.decode(bytes);screenWrites=screenWrites.then(()=>new Promise(resolve=>screen.write(bytes,resolve)));}});
 child=Bun.spawn([process.env.FUSION_OPENCODE_BIN||'opencode','--server',url,'--session',sessionID],{cwd:root,env,terminal});
 for (let i=0; i<450; i++) {
  await screenWrites;
  try {const error=await readFile(join(root,'driver-error.txt'),'utf8');throw Object.assign(new Error('UI fixture load failed'),{driverError:error});}catch(error){if(error.driverError)throw error;}
  const text=frame();
  if (text.includes('Running edit')) result.runningVisible=true;
  if (result.runningVisible && !result.stopClicked && text.includes('[Stop executor]')) {
   const lines=text.split('\n');
   const row=lines.findIndex(line=>line.includes('[Stop executor]'));
   const col=lines[row].indexOf('[Stop executor]')+3;
   terminal.write(`\x1b[<0;${col};${row+1}M\x1b[<0;${col};${row+1}m`);
   result.stopClicked=true;
  }
  if (text.includes('Stop requested; awaiting confirmation')) result.stopFeedbackVisible=true;
  if (text.includes('Ready for supervisor review')) result.completedVisible=true;
  if (result.runningVisible && result.stopFeedbackVisible && result.completedVisible) break;
  if (child.exitCode!==null) throw Error('TUI exited before display assertions');
  await delay(100);
 }
 const text=frame();
 result.titleVisible=text.includes('Implement object operations');
 result.briefCollapsed=!text.includes('LONG_BRIEF_SHOULD_STAY_COLLAPSED');
 assert.equal(result.titleVisible,true,'Compact action/title must be visible');
 assert.equal(result.runningVisible,true,'Live executor activity must be visible');
 assert.equal(result.stopClicked,true,'Stop executor control must be visible');
 assert.equal(result.stopFeedbackVisible,true,'Stop acknowledgement must update the activity card');
 assert.deepEqual(JSON.parse(await readFile(join(root,'stop-command.json'),'utf8')),{sessionID,name:'fusion-stop',text:'Stop button'},'Button must send the session-scoped stop command');
 assert.equal(result.completedVisible,true,'Completion must replace running state');
 assert.equal(result.briefCollapsed,true,'Full brief must not appear in the activity widget');
 result.ok=true;
} catch(error) {
 result.error=String(error);if(error.driverError)result.driverError=error.driverError;result.displayTail=plain().replace(/ {3,}/g,' ').slice(-3500);
 try {result.hostErrors=(await readFile(join(root,'DATA/opencode/log/opencode.log'),'utf8')).split('\n').filter(line=>line.includes('level=ERROR')).slice(-5);}catch{}
 process.exitCode=1;
}
finally {
 terminal?.write('\x03\x03');
 if(child){await Promise.race([child.exited,delay(2000)]);if(child.exitCode===null)child.kill();}
 terminal?.close();
 server.kill('SIGKILL');
 screen.dispose();
 await writeArtifact('opencode-delegate-display',result);
 await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify(result));
