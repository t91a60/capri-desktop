'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { createBridge } = require('../src/main/bridge');

function request(port, { path = '/health', method = 'GET', body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false, timeout: 2000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.end(body);
  });
}

async function start(t, options = {}) {
  const server = createBridge({ port: 0, onEvent() {}, ...options });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  assert.equal(server.address().address, '127.0.0.1');
  return server.address().port;
}

for (const target of ['//[', 'http://[']) {
  test(`malformed target ${target} returns 400 and leaves the bridge available`, () => {
    // Keep a regression from crashing the test runner with the bridge's unhandled rejection.
    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');
      const { once } = require('node:events');
      const { createBridge } = require(${JSON.stringify(require.resolve('../src/main/bridge'))});
      const request = ${request.toString()};
      (async () => {
        const events = [];
        const server = createBridge({ port: 0, onEvent: (evt) => events.push(evt) });
        try {
          await once(server, 'listening');
          assert.equal(server.address().address, '127.0.0.1');
          const port = server.address().port;
          const health = { status: 200, body: { ok: true, name: 'capri', pid: process.pid } };
          assert.deepEqual(await request(port), health);
          assert.deepEqual(await request(port, { path: ${JSON.stringify(target)}, headers: { Origin: 'https://example.invalid' } }),
            { status: 403, body: { ok: false } });
          assert.deepEqual(await request(port, { path: ${JSON.stringify(target)} }),
            { status: 400, body: { ok: false, error: 'invalid url' } });
          assert.deepEqual(await request(port), health);
          const evt = { hook_event_name: 'Stop', session_id: 'fixture', last_assistant_message: 'Done.' };
          assert.deepEqual(await request(port, { path: '/event', method: 'POST', body: JSON.stringify(evt) }),
            { status: 200, body: { ok: true } });
          assert.deepEqual(events, [evt]);
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      })().catch((err) => { console.error(err); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

test('health and event routes preserve paths, query handling and event contents', async (t) => {
  const events = [];
  const port = await start(t, { onEvent: (evt) => events.push(evt) });
  const health = await request(port, { path: '/health?check=1' });
  assert.deepEqual(health, { status: 200, body: { ok: true, name: 'capri', pid: process.pid } });
  assert.deepEqual(await request(port, { path: 'http://localhost/health' }), health);
  const evt = { hook_event_name: 'Notification', session_id: 'codex:fixture', notification_type: 'permission_prompt', message: 'Allow tests?' };
  assert.deepEqual(await request(port, { path: '/event?agent=codex', method: 'POST', body: JSON.stringify(evt) }),
    { status: 200, body: { ok: true } });
  assert.deepEqual(events, [evt]);
  assert.deepEqual(await request(port, { path: '/event' }), { status: 404, body: { ok: false } });
  assert.deepEqual(await request(port, { path: '/missing' }), { status: 404, body: { ok: false } });
});

test('Origin rejection runs before event and debug dispatch', async (t) => {
  let calls = 0;
  const port = await start(t, { onEvent: () => { calls++; }, onDebug: () => { calls++; } });
  for (const origin of ['https://example.invalid', 'null']) {
    for (const path of ['/health', '/event', '/debug/capture']) {
      assert.deepEqual(await request(port, { path, method: 'POST', headers: { Origin: origin }, body: '{"hook_event_name":"Stop"}' }),
        { status: 403, body: { ok: false } });
    }
  }
  assert.equal(calls, 0);
});

test('invalid JSON and missing event names are rejected without dispatch', async (t) => {
  const events = [];
  const port = await start(t, { onEvent: (evt) => events.push(evt) });
  assert.deepEqual(await request(port, { path: '/event', method: 'POST', body: '{broken' }),
    { status: 400, body: { ok: false, error: 'invalid json' } });
  for (const body of ['null', '[]', '{}', '{"hook_event_name":1}']) {
    assert.deepEqual(await request(port, { path: '/event', method: 'POST', body }),
      { status: 400, body: { ok: false, error: 'missing hook_event_name' } });
  }
  assert.deepEqual(events, []);
  assert.equal((await request(port)).status, 200);
});

test('512 KiB event limit accepts the boundary and disconnects oversized requests', async (t) => {
  const events = [];
  const port = await start(t, { onEvent: (evt) => events.push(evt) });
  const limit = 512 * 1024;
  const evt = { hook_event_name: 'Stop', prompt: '' };
  evt.prompt = 'x'.repeat(limit - Buffer.byteLength(JSON.stringify(evt)));
  const body = JSON.stringify(evt);
  assert.equal(Buffer.byteLength(body), limit);
  assert.equal((await request(port, { path: '/event', method: 'POST', body })).status, 200);
  await assert.rejects(request(port, { path: '/event', method: 'POST', body: body + ' ' }),
    (err) => ['ECONNRESET', 'EPIPE'].includes(err.code));
  assert.deepEqual(events, [evt]);
  assert.equal((await request(port)).status, 200);
});

test('debug routes are unavailable without a debug handler', async (t) => {
  const port = await start(t);
  for (const method of ['GET', 'POST']) {
    assert.deepEqual(await request(port, { path: '/debug/capture', method, body: '{}' }),
      { status: 404, body: { ok: false } });
  }
});

test('enabled debug routes still receive route and body and report errors', async (t) => {
  const calls = [];
  const port = await start(t, { onDebug: async (route, body) => {
    calls.push({ route, body });
    if (route === 'fail') throw new Error('fixture error');
    return { ok: true };
  } });
  assert.deepEqual(await request(port, { path: '/debug/capture?test=1', method: 'POST', body: '{"name":"fixture"}' }),
    { status: 200, body: { ok: true } });
  assert.deepEqual(await request(port, { path: '/debug/fail' }),
    { status: 500, body: { ok: false, error: 'fixture error' } });
  assert.deepEqual(calls, [{ route: 'capture', body: { name: 'fixture' } }, { route: 'fail', body: {} }]);
});
