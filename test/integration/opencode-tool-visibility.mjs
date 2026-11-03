// Native context-hook probe: stops before every model request, so no credentials or model usage are required.
import assert from "node:assert/strict";
import { writeArtifact } from "./artifact.mjs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const result = { ok: false, cases: [] };
const root = await mkdtemp(join(tmpdir(), 'fusion-visibility-'));
await mkdir(join(root, 'driver'));
await mkdir(join(root, 'home'));
await writeFile(join(root, 'opencode.json'), JSON.stringify({ plugins: [repo, './driver'] }));
await writeFile(join(root, 'driver/index.ts'), `import{writeFileSync}from'node:fs';export default{id:'visibility-probe',async setup(ctx){
await ctx.session.hook('context',e=>{writeFileSync(${JSON.stringify(join(root, 'capture.json'))},JSON.stringify({sessionID:e.sessionID,agent:e.agent,tools:Object.keys(e.tools)}));throw new Error('VISIBILITY_PROBE_STOP_BEFORE_MODEL');});
await ctx.command.transform(ed=>ed.add({name:'visibility-probe',description:'probe',execute:async args=>{await ctx.session.switchAgent({sessionID:args.sessionID,agent:args.prompt.text});await ctx.session.prompt({sessionID:args.sessionID,text:'Diagnostic only. Do not edit files.'});}}));}}`);
const env = Object.fromEntries(['PATH', 'SHELL', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
env.HOME = join(root, 'home');
env.FUSION_OWNERSHIP_DIR = join(root, 'ownership');
for (const k of ['CONFIG', 'DATA', 'CACHE', 'STATE'])
    env['XDG_' + k + '_HOME'] = join(root, k);
const child = spawn(process.env.FUSION_OPENCODE_BIN || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
for (const s of [child.stdout, child.stderr])
    s.on('data', c => { log += c; });
const delay = ms => new Promise(r => setTimeout(r, ms));
let url, password;
try {
    for (let i = 0; i < 300; i++) {
        url = log.match(/server listening on (http:\/\/\S+)/)?.[1];
        password = log.match(/server password (\S+)/)?.[1];
        if (url && password)
            break;
        await delay(100);
    }
    if (!url || !password)
        throw Error('No server readiness');
    const headers = { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'), 'content-type': 'application/json' };
    const api = async (path, body) => { const r = await fetch(url + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    await api('/api/agent');
    const s = await api('/api/session', {});
    // Reuse one conversation: switching from Build to Fusion must restore
    // the correct tool set, even after Build had no Fusion tools.
    for (const [mode, agent] of [['off', 'fusion'], ['on', 'build'], ['on', 'fusion']]) {
        const id = s.body?.id ?? s.body?.data?.id;
        if (!id)
            throw Error('No session');
        await rm(join(root, 'capture.json'), { force: true });
        const modeReply = await api('/api/session/' + id + '/command', { name: 'fusion-mode', text: mode });
        assert.ok(modeReply.status >= 200 && modeReply.status < 300, `Mode command returned ${modeReply.status}`);
        const probeReply = await api('/api/session/' + id + '/command', { name: 'visibility-probe', text: agent });
        assert.ok(probeReply.status >= 200 && probeReply.status < 300, `Probe command returned ${probeReply.status}`);
        let capture;
        for (let i = 0; i < 200; i++) {
            try {
                capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
                if (capture.sessionID === id)
                    break;
            }
            catch { }
            await delay(100);
        }
        const observed = { mode, agent, captured: !!capture && capture.sessionID === id, actualAgent: capture?.agent, fusionTools: capture?.tools?.filter(x => x.startsWith('fusion')) };
        result.cases.push(observed);
        assert.equal(observed.captured, true, 'The native context hook must be observed before model execution');
        assert.equal(observed.actualAgent, agent);
        assert.equal(observed.fusionTools.includes('fusion_start'), mode === 'on' && agent === 'fusion');
        assert.equal(observed.fusionTools.includes('fusion_delegate'), mode === 'on' && agent === 'fusion');
        if (agent !== 'fusion')
            assert.deepEqual(observed.fusionTools, []);
        console.log(JSON.stringify(observed));
    }
    result.ok = true;
}
catch (error) {
    result.error = String(error);
    process.exitCode = 1;
}
finally {
    child.kill('SIGKILL');
    await writeArtifact('opencode-tool-visibility', result, { secrets: [password].filter(Boolean) });
    await rm(root, { recursive: true, force: true });
}
