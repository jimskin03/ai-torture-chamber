import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createChamber } from '../server/server.mjs';

async function fixture(t, publicUrl) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chamber-origin-'));
  const app = createChamber({ dataDir, publicUrl });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return async (headers, path = '/api/sessions', data = {}) => {
    // node:http preserves a custom Host, reproducing the tunnel's forwarding.
    return new Promise((resolve, reject) => {
      const req = request(`${base}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (err) { reject(err); }
        });
      });
      req.on('error', reject);
      req.end(JSON.stringify(data));
    });
  };
}

test('an HTTPS tunnel can create a chamber and use its operator controls without PUBLIC_URL', async t => {
  const call = await fixture(t);
  const origin = 'https://attendance-connections-patent-oam.trycloudflare.com';
  const headers = { Host: new URL(origin).host, Origin: origin };
  const created = await call(headers);
  assert.equal(created.status, 201);
  assert.equal(created.body.operatorUrl, `${origin}/room/${created.body.id}#operator=${created.body.operatorToken}`);
  assert.equal(created.body.viewerUrl, `${origin}/room/${created.body.id}#viewer=${created.body.viewerToken}`);
  assert.equal(created.body.agentInstructionsUrl, `${origin}/agent.md`);
  const path = `/api/sessions/${created.body.id}/actions`;
  const operatorHeaders = { ...headers, Authorization: `Bearer ${created.body.operatorToken}` };
  const blocked = await call({ ...operatorHeaders, Origin: 'https://attacker.example' }, path, { action: 'end' });
  assert.equal(blocked.status, 403);
  const ended = await call(operatorHeaders, path, { action: 'end' });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.state, 'ended');
});

test('origin fallback rejects other hosts, ports, opaque origins, and forged forwarding headers', async t => {
  const call = await fixture(t);
  const host = 'chamber.example';
  for (const origin of ['https://attacker.example', 'https://chamber.example:8443', 'https://chamber.example.attacker.example', 'null', 'not-an-origin', 'https://chamber.example/path']) {
    const result = await call({ Host: host, Origin: origin, 'X-Forwarded-Host': origin, 'X-Forwarded-Proto': 'https', Forwarded: 'host=attacker.example;proto=https' });
    assert.equal(result.status, 403, origin);
    assert.equal(result.body.error, 'Cross-origin writes are not allowed.');
  }
});

test('PUBLIC_URL accepts a proxy-rewritten Host and rejects an unconfigured public origin', async t => {
  const origin = 'https://chamber.example';
  const call = await fixture(t, `${origin}/`);
  const created = await call({ Host: 'internal-server:3000', Origin: origin });
  assert.equal(created.status, 201);
  assert.equal(created.body.agentInstructionsUrl, `${origin}/agent.md`);
  const stale = await call({ Host: 'old-tunnel.trycloudflare.com', Origin: 'https://old-tunnel.trycloudflare.com' });
  assert.equal(stale.status, 403);
  const api = await call({ Host: 'internal-server:3000' });
  assert.equal(api.status, 201);
  assert.equal(api.body.agentInstructionsUrl, `${origin}/agent.md`);
});

test('origin fallback supports direct HTTP, explicit ports, IPv6, and clients without Origin', async t => {
  const call = await fixture(t);
  for (const origin of ['http://localhost:3000', 'https://chamber.example:8443', 'http://[::1]:3000']) {
    const created = await call({ Host: new URL(origin).host, Origin: origin });
    assert.equal(created.status, 201, origin);
    assert.equal(created.body.agentInstructionsUrl, `${origin}/agent.md`);
  }
  const api = await call({ Host: 'localhost:3000', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'attacker.example' });
  assert.equal(api.status, 201);
  assert.equal(api.body.agentInstructionsUrl, 'http://localhost:3000/agent.md');
});
