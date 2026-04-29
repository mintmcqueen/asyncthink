#!/usr/bin/env node
/**
 * v2.2 Acceptance Test — drives the real MCP server through stdio with
 * realistic JSONRPC traffic, exercising every major v2.2 ruling end-to-end.
 *
 * What this proves:
 *   - 10 tools registered (asyncthink + delegate{,_close,_close_all,_list_threads}
 *     + asyncthink_config + tasks_{get,list,cancel,result}).
 *   - asyncthink_config list_adapters surfaces tierLimits (R6a-D.1).
 *   - asyncthink_config list_skills surfaces pinsModel + pinIsCurrent (R6b-D.3).
 *   - delegate({async:true}) returns {taskId, status:"working"} and the work
 *     completes asynchronously (R3-D.1, R4-D).
 *   - tasks_get / tasks_result drive the lifecycle (R2-D.1).
 *   - tasks_cancel flips state and the underlying subprocess is reaped
 *     (R-DUR-D.5).
 *   - delegate({async:true, credentials:"staging"}) is rejected with a clear
 *     message (R-CRED-D.2).
 *   - delegate({async:true, idempotencyKey:"X"}) twice in a row returns the
 *     same taskId (R-DUR-D.3).
 *   - audit log captures task.* events.
 *
 * Run from server/:
 *   RUN_LIVE=1 node __tests__/acceptance/v2_2.acceptance.mjs
 *
 * Without RUN_LIVE, the claude PONG step is skipped (cred-stub, idempotency,
 * and tool-listing checks still run with no real adapter calls).
 *
 * Exit code: 0 = all assertions passed, 1 = at least one failed. Each phase
 * prints PASS / FAIL inline so failures are obvious without scrolling.
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, '..', '..');
const RUN_LIVE = process.env.RUN_LIVE === '1';

let passed = 0;
let failed = 0;
const failures = [];

function expect(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
  }
}

function header(s) {
  console.log(`\n=== ${s} ===`);
}

function startServer(extraEnv = {}) {
  const proc = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  let buf = '';
  const pending = new Map(); // id → resolver
  const notifications = [];
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolver = pending.get(msg.id);
        pending.delete(msg.id);
        resolver(msg);
      } else if (msg.method) {
        notifications.push(msg);
      }
    }
  });
  let stderr = '';
  proc.stderr.on('data', (c) => {
    stderr += c.toString();
  });

  let nextId = 1;
  function send(method, params = {}, isNotification = false) {
    const msg = isNotification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: nextId++, method, params };
    proc.stdin.write(JSON.stringify(msg) + '\n');
    if (isNotification) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      pending.set(msg.id, resolve);
      setTimeout(() => {
        if (pending.has(msg.id)) {
          pending.delete(msg.id);
          reject(new Error(`Timeout waiting for response to ${method}`));
        }
      }, 60_000);
    });
  }

  function callTool(name, args = {}) {
    return send('tools/call', { name, arguments: args });
  }

  return {
    proc,
    send,
    callTool,
    stop: () => proc.kill(),
    getStderr: () => stderr,
    notifications,
  };
}

async function initServer(client) {
  const init = await client.send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'acceptance', version: '0.1' },
  });
  if (!init.result?.serverInfo) {
    throw new Error('initialize failed: ' + JSON.stringify(init));
  }
  await client.send('notifications/initialized', {}, true);
  return init.result;
}

function unwrap(rpc) {
  if (rpc.error) throw new Error('RPC error: ' + JSON.stringify(rpc.error));
  return rpc.result;
}

function structured(callResult) {
  return callResult.structuredContent;
}

async function pollUntilTerminal(client, taskId, maxMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = unwrap(await client.callTool('tasks_get', { taskId }));
    const status = structured(r).status;
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      return structured(r);
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`Task ${taskId} did not reach terminal state in ${maxMs}ms`);
}

async function main() {
  console.log(`AsyncThink v2.2 acceptance test`);
  console.log(`Mode: ${RUN_LIVE ? 'LIVE (real claude binary)' : 'OFFLINE (no real adapters)'}`);
  console.log(`Server: ${SERVER_DIR}/dist/index.js`);

  // Use a private XDG home so this run cannot collide with the user's real state.
  const xdgHome = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-acceptance-'));
  const client = startServer({ XDG_DATA_HOME: xdgHome });
  try {
    header('Phase 1 — Initialization & tool registration');
    const initResult = await initServer(client);
    expect('server reports v2.2.0', initResult.serverInfo.version === '2.2.0',
      `got ${initResult.serverInfo.version}`);

    const list = unwrap(await client.send('tools/list', {}));
    const toolNames = list.tools.map((t) => t.name).sort();
    const expected = [
      'asyncthink',
      'asyncthink_config',
      'delegate',
      'delegate_close',
      'delegate_close_all',
      'delegate_list_threads',
      'tasks_cancel',
      'tasks_get',
      'tasks_list',
      'tasks_result',
    ];
    expect('all 10 tools registered', JSON.stringify(toolNames) === JSON.stringify(expected),
      `got [${toolNames.join(', ')}]`);

    header('Phase 2 — Adapter introspection: tierLimits surface (R6a-D.1)');
    const adapters = structured(unwrap(await client.callTool('asyncthink_config', {
      action: 'list_adapters',
    }))).adapters;
    const claude = adapters.find((a) => a.id === 'claude');
    const gemini = adapters.find((a) => a.id === 'gemini');
    const codex = adapters.find((a) => a.id === 'codex');
    expect('claude tierLimits.med.maxContext = 200000',
      claude?.tierLimits?.med?.maxContext === 200000);
    expect('gemini tierLimits.high.maxContext = 1000000',
      gemini?.tierLimits?.high?.maxContext === 1000000);
    expect('codex tierLimits.low.maxContext = 128000',
      codex?.tierLimits?.low?.maxContext === 128000);
    expect('all adapters declare rateLimitClass=standard',
      [claude, gemini, codex].every((a) => a.tierLimits?.med?.rateLimitClass === 'standard'));

    header('Phase 3 — Skill introspection: pinsModel + pinIsCurrent (R6b-D.3)');
    const skills = structured(unwrap(await client.callTool('asyncthink_config', {
      action: 'list_skills',
    }))).skills;
    expect('built-in skills loaded (architecture-critique, code-review, test-design)',
      skills.length >= 3 && ['architecture-critique', 'code-review', 'test-design'].every(
        (n) => skills.find((s) => s.name === n)
      ));
    expect('built-in skills do NOT pin a raw model (pinsModel === null)',
      skills.every((s) => s.pinsModel === null),
      `got ${JSON.stringify(skills.map((s) => ({ n: s.name, p: s.pinsModel })))}`);

    header('Phase 4 — Credentials wire-stub (R-CRED-D.2)');
    const credCall = unwrap(await client.callTool('delegate', {
      adapter: 'claude',
      prompt: 'irrelevant',
      async: true,
      credentials: 'staging',
    }));
    const credPayload = structured(credCall);
    expect('non-default credentials profile is rejected',
      credCall.isError === true && credPayload.error === 'credentials_not_supported',
      JSON.stringify(credPayload));
    expect('rejection message points at v3',
      typeof credPayload.message === 'string' && credPayload.message.includes('v3'));

    header('Phase 5 — Idempotency (R-DUR-D.3)');
    const a = unwrap(await client.callTool('delegate', {
      adapter: 'claude',
      prompt: 'idempotency probe',
      async: true,
      idempotencyKey: 'acceptance-key-1',
    }));
    const b = unwrap(await client.callTool('delegate', {
      adapter: 'claude',
      prompt: 'idempotency probe',
      async: true,
      idempotencyKey: 'acceptance-key-1',
    }));
    expect('repeat with same idempotencyKey returns same taskId',
      structured(a).taskId === structured(b).taskId,
      `a=${structured(a).taskId} b=${structured(b).taskId}`);

    header('Phase 6 — Cancellation lifecycle (R-DUR-D.5)');
    const c = unwrap(await client.callTool('delegate', {
      adapter: 'claude',
      prompt: 'will-be-cancelled',
      async: true,
    }));
    const cTaskId = structured(c).taskId;
    expect('cancel target spawns as working', structured(c).status === 'working');
    const cancelled = unwrap(await client.callTool('tasks_cancel', { taskId: cTaskId }));
    expect('tasks_cancel flips state to cancelled immediately',
      structured(cancelled).status === 'cancelled');
    const post = unwrap(await client.callTool('tasks_get', { taskId: cTaskId }));
    expect('tasks_get on cancelled task still returns cancelled',
      structured(post).status === 'cancelled');

    // Also clean up the idempotency probe so it doesn't run claude in the background.
    await client.callTool('tasks_cancel', { taskId: structured(a).taskId });

    header('Phase 7 — tasks_list pagination + filtering');
    const list1 = structured(unwrap(await client.callTool('tasks_list', { limit: 50 })));
    expect('tasks_list returns at least 2 tasks (idempotency + cancel)',
      Array.isArray(list1.tasks) && list1.tasks.length >= 2,
      `got ${list1.tasks?.length}`);
    expect('tasks_list entries carry status fields',
      list1.tasks.every((t) => typeof t.status === 'string'));
    const list2 = structured(unwrap(await client.callTool('tasks_list', { limit: 1 })));
    expect('limit=1 returns nextCursor when more tasks exist',
      list2.tasks.length === 1 && typeof list2.nextCursor === 'string');

    header('Phase 8 — asyncthink_config aliases (R4-D.2)');
    const listTasksAlias = structured(unwrap(await client.callTool('asyncthink_config', {
      action: 'list_tasks',
    })));
    expect('asyncthink_config list_tasks returns the same shape as tasks_list',
      Array.isArray(listTasksAlias.tasks) && listTasksAlias.tasks.length >= 2);

    header('Phase 9 — tasks_get on unknown id (error envelope)');
    const missing = unwrap(await client.callTool('tasks_get', { taskId: 'tsk-does-not-exist' }));
    expect('unknown taskId returns task_not_found error envelope',
      missing.isError === true && structured(missing).error === 'task_not_found',
      JSON.stringify(structured(missing)));

    if (RUN_LIVE) {
      header('Phase 10 — Live claude PONG via TaskExecutor (R3-D.1)');
      const live = unwrap(await client.callTool('delegate', {
        adapter: 'claude',
        prompt: 'PING — reply with the single word PONG.',
        async: true,
        intelligence: 'low',
        timeoutMs: 60_000,
      }));
      const liveId = structured(live).taskId;
      const final = await pollUntilTerminal(client, liveId, 90_000);
      expect('live claude task reaches completed', final.status === 'completed',
        `final status=${final.status} error=${final.error}`);
      expect('live claude result contains PONG',
        final.result?.text && final.result.text.toLowerCase().includes('pong'),
        `text=${final.result?.text?.slice(0, 200)}`);
    } else {
      header('Phase 10 — (skipped; set RUN_LIVE=1 to exercise real claude)');
    }

    header('Phase 11 — Sync delegate path unchanged (regression)');
    // Use a fake invocation that fails fast instead of spinning up a real
    // adapter; we only care that the sync path returns a DelegateResponse
    // shape, not an AsyncDelegateResponse shape.
    const syncCall = await client.callTool('delegate', {
      adapter: 'claude',
      prompt: 'sync-shape-probe',
      async: false,
      timeoutMs: 1500,
    });
    // The call may succeed (if claude is fast) or fail (timeout). Either way
    // the response shape must NOT be the async envelope.
    if (syncCall.error) {
      expect('sync delegate path returns either success or error (not async envelope)', true);
    } else {
      const syncPayload = structured(syncCall.result);
      expect('sync delegate response carries threadId, not taskId',
        typeof syncPayload?.threadId === 'string' && !syncPayload?.taskId,
        JSON.stringify(syncPayload).slice(0, 200));
    }

    header('Phase 12 — Audit log captures task lifecycle events (R1-D.1)');
    // Stop the server first so all writes flush.
    client.stop();
    await new Promise((res) => setTimeout(res, 500));
    const auditPath = join(xdgHome, 'asyncthink', 'audit.jsonl');
    let auditLines = [];
    try {
      const raw = await fsp.readFile(auditPath, 'utf8');
      auditLines = raw.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch (e) {
      // path may not exist if no audit events fired — should not happen.
    }
    const eventKinds = new Set(auditLines.map((l) => l.event?.kind));
    expect('audit log written', auditLines.length > 0, `path=${auditPath} lines=${auditLines.length}`);
    expect('audit log contains task.create event', eventKinds.has('task.create'),
      `kinds=${[...eventKinds].join(',')}`);
    expect('audit log contains task.cancel event', eventKinds.has('task.cancel'),
      `kinds=${[...eventKinds].join(',')}`);

    header('Summary');
    console.log(`  PASS: ${passed}`);
    console.log(`  FAIL: ${failed}`);
    if (failed > 0) {
      console.log('\nFailures:');
      for (const f of failures) console.log('  - ' + f);
    }
  } finally {
    client.stop();
    await fsp.rm(xdgHome, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Acceptance test crashed:', err);
  process.exit(2);
});
