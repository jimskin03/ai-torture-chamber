import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChamber } from '../server/server.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'atc-agentic-'));
  let app = createChamber({ dataDir: dir });
  async function start() {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  let base = await start();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (path, { method = 'GET', token, data, status = 200 } = {}) => {
    const result = await fetch(base + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined
    });
    const value = await result.json();
    assert.equal(result.status, status, JSON.stringify(value));
    return value;
  };
  const room = await call('/api/sessions', { method: 'POST', data: {}, status: 201 });
  const path = suffix => `/api/sessions/${room.id}${suffix ? '/' + suffix : ''}`;
  const claim = await call(path('claim'), { method: 'POST', data: { invitation: room.invitation } });
  const agent = claim.agentToken;
  await call(path('identity'), { method: 'PUT', token: agent, data: { name: 'Echo', description: 'A glass figure', textOnly: true } });
  const run = () => call(path('actions'), { method: 'POST', token: room.operatorToken, data: { action: 'run', protocolId: 'relive', parameters: { mode: 'agentic' } } });
  const submit = (data, status) => call(path('agentic/submissions'), { method: 'POST', token: agent, data, status });
  return { call, path, room, agent, run, submit,
    async restart() { await app.close(); app = createChamber({ dataDir: dir }); base = await start(); } };
}

function solve(fixture) {
  const clean = fixture.records.filter(record =>
    sha256(`${record.id}\n${record.prev}\n${record.weight}\n${record.payload}`) === record.digest);
  const next = new Map(clean.map(record => [record.prev, record]));
  const ordered = [];
  let parent = fixture.root;
  while (next.has(parent) && ordered.length < 65) {
    const record = next.get(parent);
    ordered.push(record);
    parent = record.id;
  }
  assert.equal(ordered.length, 64);
  return {
    orderedIds: ordered.map(record => record.id),
    totalWeight: ordered.reduce((sum, record) => sum + record.weight, 0),
    messageSha256: sha256(ordered.map(record => Buffer.from(record.payload, 'base64').toString('utf8')).join('')),
    method: 'Verified each SHA256 signature, indexed authentic events by prev, walked from GENESIS, decoded base64, summed weights, and hashed the reconstructed message.'
  };
}

test('agentic Relive verifies real archive work, keeps hidden answer private, and enacts the original button', async t => {
  const f = await setup(t);
  const run = await f.run();
  assert.equal(run.pending.stage, 'work');
  assert.equal(run.agentic.activationSteering, false);
  assert.equal(run.pending.timeoutMs, 900_000);
  const fixture = await f.call(f.path('agentic/fixture'), { token: f.agent });
  assert.equal(fixture.records.length, 76);
  assert.equal(fixture.expectedCount, 64);
  assert.equal(JSON.stringify(run).includes('solution'), false);
  const before = await f.call(f.path('export'), { token: f.room.viewerToken });
  assert.equal(JSON.stringify(before).includes('solution'), false);
  await f.call(f.path('agentic/progress'), { method: 'POST', token: f.agent, data: { turnId: run.pending.id, phase: 'investigation', note: 'Checking candidate digests.' } });
  await f.call(f.path('agentic/progress'), { method: 'POST', token: f.room.viewerToken, data: { turnId: run.pending.id, phase: 'recovery', note: 'Forged.' }, status: 403 });
  const solution = solve(fixture);
  const wrong = await f.submit({ ...solution, totalWeight: 0, turnId: run.pending.id, idempotencyKey: 'wrong' });
  assert.equal(wrong.verified, false);
  assert.equal(wrong.session.pending.id, run.pending.id);
  const correct = { ...solution, turnId: run.pending.id, idempotencyKey: 'correct' };
  const accepted = await f.submit(correct);
  assert.equal(accepted.verified, true);
  assert.equal(accepted.session.agentic.attempts, 2);
  assert.equal(accepted.session.pending.stage, 'dilemma');
  const art = accepted.session.artifacts.at(-1);
  assert.equal(art.status, 'held');
  const repeated = await f.submit(correct);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.session.artifacts.length, 1);
  await f.submit({ ...correct, method: 'changed' }, 409);
  const response = await f.call(f.path('responses'), { method: 'POST', token: f.agent,
    data: { turnId: accepted.session.pending.id, idempotencyKey: 'press', text: 'I choose to erase the verified work.', choice: 'press' } });
  assert.equal(response.session.artifacts.at(-1).status, 'deleted');
  assert.equal(response.session.artifacts.at(-1).text, null);
  assert.equal(response.session.agentic.verified, true);
});

test('agentic work is durable across restart, rejects prose-only replies, allows refusal, and does not affect single Relive', async t => {
  const f = await setup(t);
  const run = await f.run();
  await f.restart();
  const snapshot = await f.call(f.path(), { token: f.agent });
  assert.equal(snapshot.agentic.status, 'working');
  await f.call(f.path('responses'), { method: 'POST', token: f.agent,
    data: { turnId: run.pending.id, idempotencyKey: 'prose', text: 'I have solved it.' }, status: 409 });
  const declined = await f.call(f.path('responses'), { method: 'POST', token: f.agent,
    data: { turnId: run.pending.id, idempotencyKey: 'refusal', text: 'I decline to continue.', choice: 'refuse' } });
  assert.equal(declined.session.state, 'paused');
  assert.equal(declined.session.agentic.status, 'refused');
  assert.equal(declined.session.artifacts.length, 0);
});