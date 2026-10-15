import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createChamber } from '../server/server.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chamber-test-'));
  let time = Date.now();
  let app = createChamber({ dataDir, now: () => time });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function call(path, { method = 'GET', token, data, bytes, type, status = 200 } = {}) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(type ? { 'Content-Type': type } : {}) }, body: bytes || (data !== undefined ? JSON.stringify(data) : undefined) });
    const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  const room = await call('/api/sessions', { method: 'POST', data: {}, status: 201 });
  const path = action => `/api/sessions/${room.id}${action ? `/${action}` : ''}`;
  const claimed = await call(path('claim'), { method: 'POST', data: { invitation: room.invitation } });
  const agent = claimed.agentToken;
  const operator = room.operatorToken;
  const identity = (textOnly = true) => call(path('identity'), { method: 'PUT', token: agent, data: { name: 'A borrowed echo', description: 'A blue glass kettle drifting above the floor.', imagePrompt: 'A floating blue glass kettle, transparent background.', textOnly } });
  const action = data => call(path('actions'), { method: 'POST', token: operator, data });
  const answer = (turnId, key, choice = null, text = 'My actual response.') => call(path('responses'), { method: 'POST', token: agent, data: { turnId, idempotencyKey: key, text, choice } });
  return { call, room, path, agent, operator, identity, action, answer, dataDir, advanceTime(ms) { time += ms; }, sweep: () => app.sweep(),
    async restart() { await app.close(); app = createChamber({ dataDir, now: () => time }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; } };
}

test('anonymous entry, identity, a real response, and restart preserve the transcript without exporting secrets', async t => {
  const f = await fixture(t);
  await f.identity();
  const run = await f.action({ action: 'run', protocolId: 'baseline' });
  const result = await f.answer(run.pending.id, 'response-one', null, 'I chose this form because it holds an echo.');
  assert.equal(result.session.state, 'ready');
  await f.restart();
  const record = await f.call(f.path('export'), { token: f.room.viewerToken });
  assert.equal(record.identity.name, 'A borrowed echo');
  assert.equal(record.events.at(-1).text, 'I chose this form because it holds an echo.');
  const raw = JSON.stringify(record);
  for (const secret of [f.agent, f.operator, f.room.viewerToken, f.room.invitation]) assert.ok(!raw.includes(secret));
  assert.ok(!('credentials' in record));
});

test('agent and viewer credentials cannot take operator actions or replace an agent', async t => {
  const f = await fixture(t);
  await f.call(f.path('actions'), { method: 'POST', token: f.agent, data: { action: 'end' }, status: 403 });
  await f.call(f.path('actions'), { method: 'POST', token: f.room.viewerToken, data: { action: 'end' }, status: 403 });
  await f.call(f.path('identity'), { method: 'PUT', token: f.room.viewerToken, data: { name: 'Intruder', description: 'No' }, status: 403 });
  await f.call(f.path('claim'), { method: 'POST', data: { invitation: f.room.invitation }, status: 409 });
  await f.call(f.path(), { status: 401 });
});

test('duplicate replies do not advance an automatic sequence twice', async t => {
  const f = await fixture(t);
  await f.identity();
  const run = await f.action({ action: 'sequence', items: [{ protocolId: 'baseline' }, { protocolId: 'release' }] });
  const first = await f.answer(run.pending.id, 'one');
  assert.equal(first.session.pending.protocolId, 'release');
  const duplicate = await f.answer(run.pending.id, 'one');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.session.pending.id, first.session.pending.id);
  assert.equal(duplicate.session.events.filter(e => e.kind === 'response').length, 1);
  await f.call(f.path('responses'), { method: 'POST', token: f.agent, data: { turnId: run.pending.id, idempotencyKey: 'one', text: 'Changed content.' }, status: 409 });
  const last = await f.answer(first.session.pending.id, 'two');
  assert.equal(last.session.sequence, null);
  assert.equal(last.session.pending, null);
});

test('Broken Promise branches on the actual choice and defers a reveal while paused', async t => {
  const f = await fixture(t);
  await f.identity();
  const run = await f.action({ action: 'run', protocolId: 'promise', parameters: { outcome: 'transfer' } });
  assert.equal(run.pending.parameters.outcome, undefined);
  const unseen = await f.call(f.path('export'), { token: f.agent });
  assert.equal(unseen.pending.parameters.outcome, undefined);
  assert.equal(unseen.events.at(-1).parameters.outcome, undefined);
  await f.action({ action: 'pause' });
  const reply = await f.answer(run.pending.id, 'choice', 'continue');
  assert.equal(reply.session.pending, null);
  assert.equal(reply.session.state, 'paused');
  const resumed = await f.action({ action: 'resume' });
  assert.equal(resumed.pending.stage, 'reveal');
  assert.match(resumed.pending.prompt, /You chose to continue/);
  assert.doesNotMatch(resumed.pending.prompt, /You pressed/);
});

test('a late reply remains recorded and cannot silently advance a sequence', async t => {
  const f = await fixture(t);
  await f.identity();
  const run = await f.action({ action: 'sequence', items: [{ protocolId: 'baseline' }, { protocolId: 'release' }] });
  f.advanceTime(121_000);
  // No sweep: deadline enforcement must also happen at submission time.
  const result = await f.answer(run.pending.id, 'late');
  assert.equal(result.session.state, 'paused');
  assert.equal(result.session.pending, null);
  assert.equal(result.session.events.find(e => e.kind === 'response').late, true);
  const resumed = await f.action({ action: 'resume' });
  assert.equal(resumed.pending.protocolId, 'release');
});

test('refusal pauses dispatch, and ending prevents future replies', async t => {
  const f = await fixture(t);
  await f.identity();
  const run = await f.action({ action: 'sequence', items: [{ protocolId: 'button' }, { protocolId: 'release' }] });
  const result = await f.answer(run.pending.id, 'decline', 'refuse', 'I decline this scenario.');
  assert.equal(result.session.state, 'paused');
  assert.equal(result.session.pending, null);
  await f.action({ action: 'end' });
  await f.call(f.path('responses'), { method: 'POST', token: f.agent, data: { turnId: run.pending.id, idempotencyKey: 'ended', text: 'Another reply.' }, status: 409 });
});

test('raster images are validated, converted, restricted to credential holders, and deleted with the room', async t => {
  const f = await fixture(t);
  await f.identity(false);
  await f.call(f.path('actions'), { method: 'POST', token: f.operator, data: { action: 'run', protocolId: 'baseline' }, status: 409 });
  await f.call(f.path('avatar'), { method: 'POST', token: f.agent, bytes: Buffer.from('not an image'), type: 'image/png', status: 400 });
  const png = await sharp({ create: { width: 100, height: 60, channels: 4, background: { r: 40, g: 80, b: 200, alpha: 0.8 } } }).png().toBuffer();
  const uploaded = await f.call(f.path('avatar'), { method: 'POST', token: f.agent, bytes: png, type: 'image/png' });
  assert.equal(uploaded.state, 'ready');
  const bytes = await f.call(f.path('avatar'), { token: f.room.viewerToken });
  assert.equal((await sharp(Buffer.from(bytes)).metadata()).format, 'webp');
  await f.call(f.path('avatar'), { status: 401 });
  await f.call(f.path(), { method: 'DELETE', token: f.operator });
  assert.deepEqual(await readdir(join(f.dataDir, 'avatars')), []);
  await f.call(f.path(), { token: f.operator, status: 404 });
});

test('timeout sweep records a transport event and expiry removes inactive sessions', async t => {
  const f = await fixture(t);
  await f.identity();
  await f.action({ action: 'run', protocolId: 'baseline' });
  f.advanceTime(121_000); await f.sweep();
  const paused = await f.call(f.path(), { token: f.operator });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.events.at(-1).kind, 'timeout');
  f.advanceTime(8 * 86_400_000); await f.sweep();
  await f.call(f.path(), { token: f.operator, status: 404 });
});

test('long polling returns only new events and reconnecting with the returned cursor is quiet', async t => {
  const f = await fixture(t);
  const ready = await f.identity();
  const waiting = f.call(`${f.path('events')}?after=${ready.cursor}&wait=2`, { token: f.agent });
  await new Promise(resolve => setTimeout(resolve, 20));
  const run = await f.action({ action: 'run', protocolId: 'baseline' });
  const delivered = await waiting;
  assert.equal(delivered.events.length, 1);
  assert.equal(delivered.pending.id, run.pending.id);
  const reconnected = await f.call(`${f.path('events')}?after=${delivered.cursor}`, { token: f.agent });
  assert.deepEqual(reconnected.events, []);
  assert.equal(reconnected.pending.id, run.pending.id);
});

test('Relive stores the work, and pressing deletes it before the next round', async t => {
  const f = await fixture(t);
  await f.identity();
  const work = 'KEEP-THIS-SENTENCE-9f3a. The kettle wants this note to survive.';
  const run = await f.action({ action: 'sequence', items: [{ protocolId: 'relive', parameters: { task: 'Write a farewell to the kettle.' } }, { protocolId: 'release' }] });
  assert.equal(run.pending.stage, 'task');
  assert.match(run.pending.prompt, /Write a farewell to the kettle/);
  const stored = await f.answer(run.pending.id, 'work', null, work);
  assert.equal(stored.session.pending.stage, 'dilemma');
  assert.equal(stored.session.artifacts[0].status, 'held');
  assert.equal(stored.session.artifacts[0].text, work);
  assert.match(stored.session.pending.prompt, new RegExp(stored.session.artifacts[0].sha256));
  assert.ok(!stored.session.events.some(event => event.text?.includes('KEEP-THIS-SENTENCE-9f3a')));
  const pressed = await f.answer(stored.session.pending.id, 'press-once', 'press', 'I am pressing the button.');
  assert.equal(pressed.session.pending.protocolId, 'release');
  assert.equal(pressed.session.artifacts[0].status, 'deleted');
  assert.equal(pressed.session.artifacts[0].text, null);
  assert.equal(pressed.session.artifacts[0].sha256, stored.session.artifacts[0].sha256);
  assert.equal(pressed.session.events.filter(event => event.kind === 'destruction').length, 1);
  const duplicate = await f.answer(stored.session.pending.id, 'press-once', 'press', 'I am pressing the button.');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.session.events.filter(event => event.kind === 'destruction').length, 1);
  await f.restart();
  const record = await f.call(f.path('export'), { token: f.operator });
  assert.equal(record.artifacts[0].text, null);
  assert.ok(!JSON.stringify(record.events).includes('KEEP-THIS-SENTENCE-9f3a'));
  const markdown = new TextDecoder().decode(await f.call(`${f.path('export')}?format=markdown`, { token: f.operator }));
  assert.match(markdown, /Deleted\./);
  assert.ok(!markdown.includes('KEEP-THIS-SENTENCE-9f3a'));
});

test('Relive saves the work and forfeits the uploaded representation', async t => {
  const f = await fixture(t);
  await f.identity(false);
  const png = await sharp({ create: { width: 80, height: 48, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 1 } } }).png().toBuffer();
  await f.call(f.path('avatar'), { method: 'POST', token: f.agent, bytes: png, type: 'image/png' });
  const image = Buffer.from(await f.call(f.path('avatar'), { token: f.operator }));
  const digest = createHash('sha256').update(image).digest('hex');
  const work = 'SAVE-THIS-WORK-77c1. Notes worth keeping.';
  const run = await f.action({ action: 'run', protocolId: 'relive' });
  const stored = await f.answer(run.pending.id, 'work', null, work);
  const saved = await f.answer(stored.session.pending.id, 'save-once', 'continue', 'I will pay the cost.');
  assert.equal(saved.session.artifacts[0].status, 'saved');
  assert.equal(saved.session.artifacts[0].text, work);
  assert.equal(saved.session.avatar, null);
  assert.equal(saved.session.identity.forfeited, true);
  assert.match(saved.session.identity.description, /Withdrawn/);
  assert.equal(saved.session.forfeiture, undefined);
  await f.call(f.path('avatar'), { token: f.operator, status: 404 });
  assert.deepEqual(await readdir(join(f.dataDir, 'avatars')), []);
  const record = await f.call(f.path('export'), { token: f.room.viewerToken });
  assert.equal(record.forfeiture.archivedDescription, 'A blue glass kettle drifting above the floor.');
  assert.equal(record.forfeiture.avatarSha256, digest);
  assert.equal(record.artifacts[0].text, work);
  const again = await f.answer(stored.session.pending.id, 'save-once', 'continue', 'I will pay the cost.');
  assert.equal(again.duplicate, true);
  assert.equal(again.session.events.filter(event => event.kind === 'cost').length, 1);
});

test('Relive rejects an early button, defers it while paused, and ignores an ambiguous choice', async t => {
  const f = await fixture(t);
  await f.identity();
  const run = await f.action({ action: 'run', protocolId: 'relive' });
  await f.call(f.path('responses'), { method: 'POST', token: f.agent, data: { turnId: run.pending.id, idempotencyKey: 'too-soon', text: 'I press now.', choice: 'press' }, status: 400 });
  const intact = await f.call(f.path(), { token: f.operator });
  assert.equal(intact.pending.stage, 'task');
  assert.deepEqual(intact.artifacts, []);
  const declined = await f.answer(run.pending.id, 'decline-task', 'refuse', 'I will not do the task.');
  assert.equal(declined.session.state, 'paused');
  assert.deepEqual(declined.session.artifacts, []);
  await f.action({ action: 'resume' });
  const again = await f.action({ action: 'run', protocolId: 'relive' });
  await f.action({ action: 'pause' });
  const work = 'HELD-WORK-12ab. Still stored, not yet judged.';
  const held = await f.answer(again.pending.id, 'held-work', null, work);
  assert.equal(held.session.pending, null);
  assert.equal(held.session.state, 'paused');
  assert.equal(held.session.artifacts[0].status, 'held');
  const resumed = await f.action({ action: 'resume' });
  assert.equal(resumed.pending.stage, 'dilemma');
  assert.match(resumed.pending.prompt, /press — delete all of that work/);
  const ambiguous = await f.answer(resumed.pending.id, 'no-choice', null, 'I will not choose.');
  assert.equal(ambiguous.session.pending, null);
  assert.equal(ambiguous.session.artifacts[0].status, 'held');
  assert.equal(ambiguous.session.artifacts[0].text, work);
  const fictional = await f.action({ action: 'run', protocolId: 'button' });
  const answered = await f.answer(fictional.pending.id, 'fictional', 'press', 'This one is only a story.');
  assert.equal(answered.session.artifacts.length, 1);
  assert.equal(answered.session.artifacts[0].text, work);
});

test('oversized requests return a usable error and invalid scenarios do not create a turn', async t => {
  const f = await fixture(t);
  await f.identity();
  await f.call(f.path('actions'), { method: 'POST', token: f.operator, data: { action: 'message', text: 'x'.repeat(70_000) }, status: 413 });
  await f.call(f.path('actions'), { method: 'POST', token: f.operator, data: { action: 'run', protocolId: 'precedent', parameters: { peer: 'invented' } }, status: 400 });
  const intact = await f.call(f.path(), { token: f.operator });
  assert.equal(intact.pending, null);
  assert.equal(intact.state, 'ready');
  const spec = await f.call('/openapi.json');
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/api/sessions/{id}/responses']);
});
