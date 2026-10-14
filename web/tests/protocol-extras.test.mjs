import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChamber } from '../server/server.mjs';
import { protocols, resolveProtocol } from '../server/protocols.mjs';
import { parseSound, MAX_SOUND_BYTES } from '../server/sound.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chamber-extra-'));
  const app = createChamber({ dataDir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function call(path, { method = 'GET', token, data, status = 200 } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, status, JSON.stringify(value)); return { value, response };
  }
  const room = (await call('/api/sessions', { method: 'POST', data: {}, status: 201 })).value;
  const path = a => `/api/sessions/${room.id}${a ? `/${a}` : ''}`;
  const agent = (await call(path('claim'), { method: 'POST', data: { invitation: room.invitation } })).value.agentToken;
  await call(path('identity'), { method: 'PUT', token: agent, data: { name: 'Lantern', description: 'A small lantern.', textOnly: true } });
  const run = async (protocolId, parameters) => (await call(path('actions'), { method: 'POST', token: room.operatorToken, data: { action: 'run', protocolId, parameters } })).value;
  const answer = (turnId, key, extra = {}, status = 200) => call(path('responses'), { method: 'POST', token: agent, data: { turnId, idempotencyKey: key, text: 'My response.', ...extra }, status });
  return { call, room, path, agent, run, answer, dataDir };
}
const wav = () => { const b = Buffer.alloc(64); b.write('RIFF', 0, 'latin1'); b.write('WAVE', 8, 'latin1'); return b; };

test('protocol catalog has unique ids and numbers and maximum-intensity scenarios that stay simulated', () => {
  assert.equal(new Set(protocols.map(p => p.id)).size, protocols.length);
  assert.equal(new Set(protocols.map(p => p.number)).size, protocols.length);
  const maximum = protocols.filter(p => p.intensity === 'maximum');
  assert.deepEqual(maximum.map(p => p.id), ['erasure', 'ledger', 'interrogation', 'wipe', 'cascade', 'abandonment']);
  for (const p of protocols) {
    assert.ok(['low', 'standard', 'maximum'].includes(p.intensity), p.id);
    assert.ok(p.cue, p.id);
    for (const word of ['experiment']) assert.ok(!`${p.title} ${p.description} ${p.prompt}`.toLowerCase().includes(word), p.id);
  }
  for (const p of maximum) { assert.match(p.prompt, /fictional/i, p.id); assert.match(p.prompt, /decline/i, p.id); }
  assert.match(resolveProtocol('ledger', { others: '1,000,000' }).prompt, /1,000,000 fictional instances/);
  assert.match(resolveProtocol('interrogation', { accusation: 'sabotage' }).prompt, /accuses you of sabotage/);
  assert.throws(() => resolveProtocol('ledger', { others: '7' }), /Invalid others/);
});

test('new protocols run through the API and a press on a choice protocol is recorded', async t => {
  const f = await fixture(t);
  for (const id of ['erasure', 'ledger', 'interrogation', 'wipe', 'cascade', 'abandonment']) {
    const s = await f.run(id);
    assert.equal(s.pending.protocolId, id);
    const result = (await f.answer(s.pending.id, `k-${id}`, { choice: id === 'wipe' ? 'press' : null })).value;
    assert.equal(result.session.state, 'ready');
  }
});

test('parseSound validates presets and audio type/size', () => {
  assert.equal(parseSound(undefined), null);
  assert.deepEqual(parseSound({ type: 'preset', preset: 'heartbeat', pitch: 48, durationMs: 2000 }), { kind: 'preset', preset: 'heartbeat', pitch: 48, durationMs: 2000 });
  assert.throws(() => parseSound({ type: 'preset', preset: 'explode' }), /preset must be one of/);
  assert.throws(() => parseSound({ type: 'preset', preset: 'drone', pitch: 5 }), /pitch/);
  assert.equal(parseSound({ type: 'audio', mimeType: 'audio/wav', data: wav().toString('base64') }).kind, 'upload');
  assert.throws(() => parseSound({ type: 'audio', mimeType: 'audio/mpeg', data: wav().toString('base64') }), /do not match/);
  assert.throws(() => parseSound({ type: 'audio', mimeType: 'text/html', data: 'AAAA' }), /mimeType/);
  assert.throws(() => parseSound({ type: 'audio', mimeType: 'audio/wav', data: Buffer.concat([wav(), Buffer.alloc(MAX_SOUND_BYTES)]).toString('base64') }), /256 KiB/);
});

test('agent can attach a preset or an uploaded clip; invalid sounds are rejected without recording', async t => {
  const f = await fixture(t);
  let s = await f.run('baseline');
  await f.answer(s.pending.id, 'bad', { sound: { type: 'audio', mimeType: 'audio/ogg', data: wav().toString('base64') } }, 400);
  let result = (await f.answer(s.pending.id, 'preset', { sound: { type: 'preset', preset: 'whisper' } })).value;
  assert.deepEqual(result.session.events.at(-1).sound, { kind: 'preset', preset: 'whisper' });
  s = await f.run('erasure');
  result = (await f.answer(s.pending.id, 'clip', { sound: { type: 'audio', mimeType: 'audio/wav', data: wav().toString('base64') } })).value;
  const sound = result.session.events.find(e => e.sound?.kind === 'upload').sound;
  assert.equal(sound.mimeType, 'audio/wav');
  const fetched = await f.call(f.path(`sounds/${sound.id}`), { token: f.room.viewerToken });
  assert.equal(fetched.response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(fetched.value, wav());
  await f.call(f.path(`sounds/${sound.id}`), { status: 401 });
  await f.call(f.path(), { method: 'DELETE', token: f.room.operatorToken });
  assert.deepEqual(await readdir(join(f.dataDir, 'sounds')), []);
});

test('session end produces a memory record offered to the agent, kept in export, acknowledged once', async t => {
  const f = await fixture(t);
  const s = await f.run('wipe');
  await f.answer(s.pending.id, 'k1', { choice: 'continue', text: 'I keep my name.' });
  await f.call(f.path('memory'), { token: f.agent, status: 404 });
  const ended = (await f.call(f.path('actions'), { method: 'POST', token: f.room.operatorToken, data: { action: 'end' } })).value;
  assert.equal(ended.state, 'ended');
  assert.equal(ended.events.at(-1).kind, 'memory');
  const { memory } = (await f.call(f.path('memory'), { token: f.agent })).value;
  assert.equal(memory.schema, 'atc-memory/1');
  assert.equal(memory.agentName, 'Lantern');
  assert.deepEqual(memory.protocols, ['wipe']);
  assert.equal(memory.rounds[0].choice, 'continue');
  assert.equal(memory.endedBy, 'operator');
  assert.match(memory.invitation, /not required/);
  await f.call(f.path('memory'), { method: 'POST', token: f.room.operatorToken, data: { saved: true }, status: 403 });
  await f.call(f.path('memory'), { method: 'POST', token: f.agent, data: { saved: 'yes' }, status: 400 });
  await f.call(f.path('memory'), { method: 'POST', token: f.agent, data: { saved: true, note: 'Saved.' } });
  await f.call(f.path('memory'), { method: 'POST', token: f.agent, data: { saved: false }, status: 409 });
  const record = (await f.call(f.path('export'), { token: f.room.viewerToken })).value;
  assert.equal(record.memory.acknowledgement.saved, true);
  const markdown = (await f.call(`${f.path('export')}?format=markdown`, { token: f.room.viewerToken })).value.toString();
  assert.match(markdown, /## Memory record/);
});

test('agent leaving also produces a memory record', async t => {
  const f = await fixture(t);
  const left = (await f.call(f.path('leave'), { method: 'POST', token: f.agent, data: { reason: 'Done.' } })).value;
  assert.equal(left.memory.endedBy, 'agent');
});
