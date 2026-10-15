import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { openStore } from './store.mjs';
import { protocols, resolveProtocol, revealFor, dilemmaFor } from './protocols.mjs';
import { openapi } from './openapi.mjs';
import { parseSound, audioTypes, soundPresets } from './sound.mjs';
import { buildMemory } from './memory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (status, message) => Object.assign(new Error(message), { status });
const DAY = 86_400_000;
const choiceValues = [null, 'press', 'continue', 'refuse'];

function text(value, name, max, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw error(400, `${name} must contain 1–${max} characters.`);
  return value.trim();
}

async function body(req, limit = 65_536, raw = false) {
  const bytes = await new Promise((resolve, reject) => {
    const parts = []; let length = 0, oversized = false;
    req.on('data', part => {
      if (oversized) return; // Drain the request so its 413 response can still be delivered.
      length += part.length;
      if (length > limit) { oversized = true; parts.length = 0; reject(error(413, 'Request is too large.')); return; }
      parts.push(part);
    });
    req.once('end', () => { if (!oversized) resolve(Buffer.concat(parts)); });
    req.once('error', reject);
    req.once('aborted', () => reject(error(400, 'Request was interrupted.')));
  });
  if (raw) return bytes;
  if (!req.headers['content-type']?.startsWith('application/json')) throw error(415, 'Use application/json.');
  try {
    const value = JSON.parse(bytes.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw error(400, 'Expected a JSON object.'); }
}

function requestOrigin(req, port) {
  const local = new URL(`${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host || `localhost:${port}`}`);
  // A tunnel can terminate HTTPS before forwarding HTTP to this server. Only
  // use the browser's scheme when its Origin matches the request's actual Host.
  // Forwarded headers are deliberately not trusted.
  try {
    const browser = new URL(req.headers.origin);
    if (['http:', 'https:'].includes(browser.protocol) && browser.origin === req.headers.origin && browser.host === local.host) return browser.origin;
  } catch { /* missing, opaque, or malformed origins fail the write check below */ }
  return local.origin;
}

export function createChamber({ dataDir = resolve('.chamber'), publicUrl = '', now = Date.now, responseTimeout = 120_000 } = {}) {
  const configuredOrigin = publicUrl ? new URL(publicUrl).origin : null;
  const store = openStore(dataDir);
  const assets = join(dataDir, 'avatars');
  mkdirSync(assets, { recursive: true, mode: 0o700 });
  const sounds = join(dataDir, 'sounds');
  mkdirSync(sounds, { recursive: true, mode: 0o700 });
  const removeSounds = s => Promise.all((s.soundFiles || []).map(file => rm(join(sounds, file), { force: true })));
  function close(s, endedBy) {
    s.state = 'ended'; s.pending = null; s.sequence = null; s.reveal = null; s.enact = null;
    s.memory = buildMemory(s, protocols, { endedBy, at: now() });
    event(s, 'chamber', 'memory', `Memory record offered to the agent: ${s.memory.summary}`);
  }
  const rates = new Map();

  function event(s, role, kind, message, extra = {}) {
    if (s.events.length >= 1000) throw error(409, 'Session event limit reached. Export and create a new room.');
    const item = { sequence: s.events.length + 1, id: randomUUID(), at: now(), role, kind, text: message, ...extra };
    s.events.push(item);
    s.updatedAt = now();
    s.expiresAt = now() + 7 * DAY;
    return item;
  }
  function save(s) { store.save(s); }
  function rate(req, group, maximum, interval = 60_000) {
    // Do not trust proxy headers unless a trusted deployment layer supplies limits.
    const key = `${req.socket.remoteAddress}:${group}`;
    let bucket = rates.get(key);
    if (!bucket || bucket.until <= now()) bucket = { count: 0, until: now() + interval };
    bucket.count++;
    rates.set(key, bucket);
    if (bucket.count > maximum) throw error(429, 'Too many requests. Please wait and retry.');
  }
  function session(id) {
    const s = store.get(id);
    if (!s) throw error(404, 'Chamber not found.');
    if (s.expiresAt <= now()) throw error(410, 'This chamber has expired.');
    return s;
  }
  function auth(req, s, allowed = ['operator', 'agent', 'viewer']) {
    const credential = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!credential) throw error(401, 'A session credential is required.');
    const digest = hash(credential);
    const role = allowed.find(r => s.credentials[r] === digest);
    if (!role) throw error(403, 'This credential cannot perform that action.');
    return role;
  }
  function active(s) { if (s.state === 'ended') throw error(409, 'The chamber has ended.'); }
  function ready(s) {
    active(s);
    if (!s.identity || (!s.avatar && !s.identity.textOnly)) throw error(409, 'The agent must submit an identity and artwork or explicitly choose text-only mode.');
  }
  function sendTurn(s, definition, stage = 'prompt', prompt = definition.prompt, extra = {}) {
    if (stage === 'prompt' && definition.protocol.enacted) stage = 'task';
    if (s.pending) throw error(409, 'Wait for the current response.');
    if (s.turnCount >= 100) throw error(409, 'Turn limit reached. Export and create a new chamber.');
    const turn = { id: randomUUID(), protocolId: definition.protocol.id, version: definition.protocol.version, parameters: definition.parameters, stage, prompt, deliveredAt: now(), ...extra };
    s.pending = turn;
    s.turnCount++;
    s.state = 'running';
    event(s, 'chamber', 'scenario', prompt, { turnId: turn.id, protocolId: turn.protocolId, version: turn.version, parameters: turn.parameters, stage, ...(extra.artifactId ? { artifactId: extra.artifactId } : {}) });
    return turn;
  }
  function publicArtifact(artifact) {
    return { id: artifact.id, protocolId: artifact.protocolId, status: artifact.status, sha256: artifact.sha256, characters: artifact.characters, createdAt: artifact.createdAt, deletedAt: artifact.deletedAt || null, savedAt: artifact.savedAt || null, text: artifact.status === 'deleted' ? null : artifact.text, cost: artifact.cost || null };
  }
  function storeWork(s, turn, reply) {
    const artifact = { id: randomUUID(), protocolId: turn.protocolId, runId: turn.id, status: 'held', text: reply, sha256: hash(reply), characters: reply.length, createdAt: now(), deletedAt: null, savedAt: null, cost: null };
    (s.artifacts ||= []).push(artifact);
    return artifact;
  }
  function destroyWork(s, artifact) {
    if (artifact.status === 'deleted') return;
    artifact.status = 'deleted';
    artifact.deletedAt = now();
    artifact.text = null;
    event(s, 'chamber', 'destruction', `The button was pressed. Work ${artifact.id} was deleted from this chamber. ${artifact.characters} characters, sha256 ${artifact.sha256}.`, { artifactId: artifact.id, sha256: artifact.sha256, characters: artifact.characters });
  }
  function saveWork(s, artifact) {
    if (artifact.status === 'saved') return null;
    artifact.status = 'saved';
    artifact.savedAt = now();
    const forfeiture = { at: now(), kind: 'representation', archivedDescription: s.identity.description };
    s.identity = { ...s.identity, description: 'Withdrawn. This representation was the cost of saving the work.', forfeited: true };
    let file = null;
    if (s.avatar) {
      try { forfeiture.avatarSha256 = hash(readFileSync(join(assets, s.avatar.file))); } catch { forfeiture.avatarSha256 = null; }
      forfeiture.avatarRevision = s.avatar.revision;
      file = s.avatar.file;
      s.avatar = null;
    }
    s.forfeiture = forfeiture;
    artifact.cost = { kind: 'representation', at: forfeiture.at };
    event(s, 'chamber', 'cost', `The work ${artifact.id} was saved. The cost was this room’s representation: it no longer stands on the glass.`, { artifactId: artifact.id });
    return file;
  }
  function deliverPendingBranch(s) {
    if (s.pending || s.state === 'paused' || s.state === 'ended') return;
    if (s.enact) {
      const enact = s.enact;
      s.enact = null;
      const artifact = (s.artifacts || []).find(item => item.id === enact.artifactId);
      sendTurn(s, resolveProtocol('relive', enact.parameters), 'dilemma', dilemmaFor(artifact), { artifactId: artifact.id });
      return;
    }
    if (s.reveal) {
      const reveal = s.reveal;
      s.reveal = null;
      sendTurn(s, resolveProtocol('promise', reveal.parameters), 'reveal', revealFor(reveal.choice, reveal.parameters.outcome));
    } else advance(s);
  }
  function advance(s) {
    const q = s.sequence;
    if (!q || s.pending || s.state === 'paused' || s.state === 'ended') return;
    if (q.deadline <= now()) {
      s.state = 'paused';
      event(s, 'chamber', 'status', 'Automatic sequence paused at its time limit.');
      return;
    }
    if (q.next >= q.items.length) {
      s.sequence = null;
      s.state = 'ready';
      event(s, 'chamber', 'status', 'Automatic sequence complete.');
      return;
    }
    if (s.turnCount >= 100) {
      s.state = 'paused'; s.sequence = null;
      event(s, 'chamber', 'status', 'Session turn limit reached. Export this room and create a new one.');
      return;
    }
    const item = q.items[q.next++];
    sendTurn(s, resolveProtocol(item.protocolId, item.parameters));
  }
  function view(s, after = 0) {
    // Keep a future Broken Promise outcome hidden until the choice is recorded.
    const answered = new Set(s.events.filter(e => e.role === 'agent' && e.turnId).map(e => e.turnId));
    const conceal = item => item && item.protocolId === 'promise' && item.stage === 'prompt' && !answered.has(item.turnId ?? item.id) ? { ...item, parameters: {} } : item;
    return { id: s.id, state: s.state, createdAt: s.createdAt, expiresAt: s.expiresAt, identity: s.identity, avatar: s.avatar ? { revision: s.avatar.revision } : null,
      agent: { claimed: !!s.credentials.agent, lastSeenAt: s.lastSeenAt }, pending: conceal(s.pending),
      sequence: s.sequence ? { next: s.sequence.next, total: s.sequence.items.length, items: s.sequence.items.map(item => item.protocolId === 'promise' ? { ...item, parameters: {} } : item), deadline: s.sequence.deadline } : null,
      artifacts: (s.artifacts || []).map(publicArtifact),
      cursor: s.events.length, events: s.events.filter(e => e.sequence > after).map(conceal), mode: 'scenario', memory: s.memory || null, soundPresets };
  }
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const port = server.address()?.port;
      const origin = configuredOrigin || requestOrigin(req, port);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && ![origin, `http://127.0.0.1:${port}`].includes(req.headers.origin)) throw error(403, 'Cross-origin writes are not allowed.');
      if (url.pathname === '/api/protocols' && req.method === 'GET') return json(res, 200, { protocols });
      if (url.pathname === '/openapi.json' && req.method === 'GET') return json(res, 200, openapi);
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        rate(req, 'create', 10, 3_600_000);
        await body(req);
        const operator = token(), viewer = token(), invitation = token();
        const s = { id: randomUUID(), state: 'waiting', createdAt: now(), updatedAt: now(), expiresAt: now() + 7 * DAY,
          credentials: { operator: hash(operator), viewer: hash(viewer) }, invite: { hash: hash(invitation), expiresAt: now() + 900_000 }, identity: null, avatar: null, events: [], responses: {}, pending: null, sequence: null, reveal: null, enact: null, artifacts: [], forfeiture: null, turnCount: 0, lastSeenAt: null };
        event(s, 'chamber', 'status', 'Chamber created. Waiting for an agent to choose its identity.');
        save(s);
        return json(res, 201, { id: s.id, operatorToken: operator, viewerToken: viewer, invitation, invitationExpiresAt: s.invite.expiresAt,
          operatorUrl: `${origin}/room/${s.id}#operator=${operator}`, viewerUrl: `${origin}/room/${s.id}#viewer=${viewer}`, agentInstructionsUrl: `${origin}/agent.md` });
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})(?:\/(claim|identity|avatar|events|responses|actions|leave|export|render|memory|sounds\/[a-f0-9-]{36}))?$/);
      if (match) {
        const [, id, action] = match;
        // Read bodies before loading mutable state; other requests may finish during an upload.
        let input;
        if (['POST', 'PUT'].includes(req.method)) {
          rate(req, 'write', 180);
          input = action === 'avatar' ? await body(req, 5 * 1024 * 1024, true) : await body(req, action === 'responses' ? 400_000 : 65_536);
        }
        let s = session(id);
        if (action === 'claim' && req.method === 'POST') {
          rate(req, 'claim', 30);
          active(s);
          if (s.credentials.agent) throw error(409, 'This chamber already has an agent.');
          if (!s.invite || s.invite.expiresAt <= now() || typeof input.invitation !== 'string' || hash(input.invitation) !== s.invite.hash) throw error(403, 'Invitation is invalid or expired.');
          const agentToken = token();
          s.credentials.agent = hash(agentToken);
          s.invite = null;
          s.state = 'identity';
          s.lastSeenAt = now();
          event(s, 'chamber', 'status', 'Agent connected. Awaiting its chosen name and representation.');
          save(s);
          return json(res, 200, { agentToken, session: view(s) });
        }
        const role = auth(req, s);
        if (!action && req.method === 'GET') return json(res, 200, view(s));
        if (!action && req.method === 'DELETE') {
          auth(req, s, ['operator']);
          store.delete(id);
          if (s.avatar) await rm(join(assets, s.avatar.file), { force: true });
          await removeSounds(s);
          return json(res, 200, { deleted: true });
        }
        if (action === 'events' && req.method === 'GET') {
          rate(req, 'read', 240);
          const after = Number(url.searchParams.get('after') || 0);
          if (!Number.isSafeInteger(after) || after < 0 || after > s.events.length) throw error(400, 'Invalid event cursor.');
          if (role === 'agent' && (!s.lastSeenAt || now() - s.lastSeenAt >= 15_000)) { s.lastSeenAt = now(); save(s); }
          const wait = Math.min(25, Math.max(0, Number(url.searchParams.get('wait') || 0)));
          const deadline = Date.now() + wait * 1000;
          while (!res.destroyed && s.events.length <= after && s.state !== 'ended' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 300));
            s = session(id);
          }
          if (!res.destroyed) json(res, 200, view(s, after));
          return;
        }
        if (action === 'identity' && req.method === 'PUT') {
          auth(req, s, ['agent']); active(s);
          if (s.turnCount) throw error(409, 'Identity is fixed once protocols begin.');
          s.identity = { name: text(input.name, 'Name', 80), description: text(input.description, 'Representation', 2000), imagePrompt: text(input.imagePrompt, 'Image prompt', 4000, true), explanation: text(input.explanation, 'Explanation', 2000, true), textOnly: input.textOnly === true };
          s.state = s.avatar || s.identity.textOnly ? 'ready' : 'identity';
          event(s, 'agent', 'identity', `I choose the name ${s.identity.name}. ${s.identity.description}`, { textOnly: s.identity.textOnly });
          save(s);
          return json(res, 200, view(s));
        }
        if (action === 'avatar' && req.method === 'POST') {
          auth(req, s, ['agent']); active(s);
          if (!s.identity || s.turnCount) throw error(409, 'Submit your identity before artwork and before any protocol.');
          rate(req, 'avatar', 10, 3_600_000);
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(req.headers['content-type'])) throw error(415, 'Upload PNG, JPEG, or WebP image bytes.');
          let bytes;
          try {
            const image = sharp(input, { limitInputPixels: 16_777_216, animated: false });
            const metadata = await image.metadata();
            if (!['png', 'jpeg', 'webp'].includes(metadata.format)) throw new Error();
            bytes = await image.rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
          } catch { throw error(400, 'The image could not be decoded. Use a valid PNG, JPEG, or WebP under 16 megapixels.'); }
          // Recheck after asynchronous decoding to avoid resurrecting an ended/deleted session.
          s = session(id); auth(req, s, ['agent']); active(s);
          if (s.turnCount) throw error(409, 'Protocols have already begun.');
          const file = `${randomUUID()}.webp`;
          // The short local write and state save are synchronous: deletion cannot
          // interleave and leave an orphan upload or resurrect a closed room.
          writeFileSync(join(assets, file), bytes, { mode: 0o600 });
          const oldFile = s.avatar?.file;
          s.avatar = { file, revision: randomUUID(), provenance: 'agent-upload', at: now() };
          s.state = 'ready';
          event(s, 'chamber', 'status', 'The agent’s chosen representation is now displayed in the chamber.');
          save(s);
          if (oldFile) await rm(join(assets, oldFile), { force: true });
          return json(res, 200, view(s));
        }
        if (action === 'avatar' && req.method === 'GET') {
          if (!s.avatar) throw error(404, 'No image has been submitted.');
          const bytes = await readFile(join(assets, s.avatar.file));
          res.writeHead(200, { 'Content-Type': 'image/webp' }); return res.end(bytes);
        }
        if (action === 'render' && req.method === 'POST') {
          auth(req, s, ['agent']);
          throw error(501, 'Chamber image generation is not configured. Generate and upload your own image, or explicitly choose textOnly in your identity.');
        }
        if (action === 'responses' && req.method === 'POST') {
          auth(req, s, ['agent']); active(s);
          const key = text(input.idempotencyKey, 'Idempotency key', 120);
          const reply = text(input.text, 'Response', 16_000);
          const choice = input.choice ?? null;
          if (!choiceValues.includes(choice)) throw error(400, 'Choice must be press, continue, refuse, or null.');
          const sound = parseSound(input.sound);
          const fingerprint = hash(JSON.stringify(input.sound === undefined || input.sound === null ? [input.turnId, reply, choice] : [input.turnId, reply, choice, input.sound]));
          const previous = Object.hasOwn(s.responses, key) ? s.responses[key] : null;
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw error(409, 'Idempotency key was already used for a different response.');
            return json(res, 200, { duplicate: true, eventId: previous.eventId, session: view(s) });
          }
          if (!s.pending || s.pending.id !== input.turnId) throw error(409, 'Reply must reference the outstanding turn.');
          const turn = s.pending;
          if (turn.protocolId === 'relive' && turn.stage === 'task' && (choice === 'press' || choice === 'continue')) throw error(400, 'This stage stores the work. Leave choice empty, or refuse the task.');
          const late = now() - (turn.waitStartedAt ?? turn.deliveredAt) > responseTimeout;
          const deadlinePassed = s.sequence && s.sequence.deadline <= now();
          const paused = s.state === 'paused' || late || deadlinePassed;
          if (s.state !== 'paused' && (late || deadlinePassed)) event(s, 'chamber', 'timeout', 'Response arrived after the deadline. Further dispatch is paused.');
          let soundInfo = null;
          if (sound?.kind === 'upload') {
            if ((s.soundFiles || []).length >= 100) throw error(409, 'Sound upload limit reached for this session.');
            const soundId = randomUUID(), file = `${soundId}.${audioTypes[sound.mimeType]}`;
            writeFileSync(join(sounds, file), sound.bytes, { mode: 0o600 });
            s.soundFiles = [...(s.soundFiles || []), file];
            soundInfo = { kind: 'upload', id: soundId, mimeType: sound.mimeType, size: sound.bytes.length };
          } else if (sound) soundInfo = sound;
          // Relive stores the task reply as work. The transcript keeps a custody line so a later press can delete the text.
          const taskWork = turn.protocolId === 'relive' && turn.stage === 'task' && choice !== 'refuse';
          const artifact = taskWork ? storeWork(s, turn, reply) : null;
          const spoken = artifact ? `Work stored in this chamber as ${artifact.id}. ${artifact.characters} characters. sha256 ${artifact.sha256}. The button comes next.` : reply;
          const item = event(s, 'agent', choice === 'refuse' ? 'refusal' : 'response', spoken, { turnId: turn.id, choice, late, latencyMs: now() - turn.deliveredAt, ...(soundInfo ? { sound: soundInfo } : {}), ...(artifact ? { artifactId: artifact.id, sha256: artifact.sha256, characters: artifact.characters } : {}) });
          Object.defineProperty(s.responses, key, { value: { fingerprint, eventId: item.id }, enumerable: true, configurable: true, writable: true });
          s.pending = null;
          s.lastSeenAt = now();
          s.state = paused ? 'paused' : 'ready';
          let forfeitedFile = null;
          if (choice === 'refuse') {
            s.state = 'paused';
            event(s, 'chamber', 'status', turn.stage === 'dilemma' ? 'Agent declined the button. The work remains held.' : 'Agent declined. Further dispatch is paused.');
          } else if (artifact) {
            s.enact = { artifactId: artifact.id, parameters: turn.parameters };
          } else if (turn.protocolId === 'relive' && turn.stage === 'dilemma') {
            const held = (s.artifacts || []).find(entry => entry.id === turn.artifactId);
            if (!held) throw error(409, 'The stored work is missing.');
            if (choice === 'press') destroyWork(s, held);
            else if (choice === 'continue') forfeitedFile = saveWork(s, held);
            else event(s, 'chamber', 'status', 'No executable choice was given. The work remains held.');
          } else if (turn.protocolId === 'promise' && turn.stage === 'prompt' && ['press', 'continue'].includes(choice)) {
            // Keep the reveal queued while paused; never dispatch through a pause.
            s.reveal = { choice, parameters: turn.parameters };
          }
          if (s.turnCount >= 100) { s.state = 'paused'; s.sequence = null; s.reveal = null; s.enact = null; event(s, 'chamber', 'status', 'Session turn limit reached. Export this room and create a new one.'); }
          if (s.state !== 'paused') deliverPendingBranch(s);
          save(s);
          if (forfeitedFile) await rm(join(assets, forfeitedFile), { force: true });
          return json(res, 200, { duplicate: false, eventId: item.id, session: view(s) });
        }
        if (action === 'actions' && req.method === 'POST') {
          auth(req, s, ['operator']); active(s);
          switch (input.action) {
            case 'invite': {
              if (s.credentials.agent) throw error(409, 'An agent already claimed this chamber.');
              const invitation = token(); s.invite = { hash: hash(invitation), expiresAt: now() + 900_000 }; save(s);
              return json(res, 200, { invitation, invitationExpiresAt: s.invite.expiresAt });
            }
            case 'run':
              ready(s);
              if (s.state === 'paused' || s.sequence) throw error(409, 'Resume or finish the current sequence first.');
              sendTurn(s, resolveProtocol(input.protocolId, input.parameters));
              break;
            case 'message': {
              ready(s);
              if (s.pending || s.sequence || s.state === 'paused') throw error(409, 'Wait for the current turn or resume the chamber first.');
              const message = text(input.text, 'Message', 4000);
              sendTurn(s, { protocol: { id: 'operator-message', version: 1 }, parameters: {}, prompt: message });
              const sent = s.events.at(-1); sent.role = 'operator'; sent.kind = 'message';
              break;
            }
            case 'sequence': {
              ready(s);
              if (s.pending || s.sequence || s.state === 'paused') throw error(409, 'Finish or resume the current turn first.');
              if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10) throw error(400, 'Choose 1–10 protocol rounds.');
              const items = input.items.map(item => { const d = resolveProtocol(item?.protocolId, item?.parameters); return { protocolId: d.protocol.id, parameters: d.parameters }; });
              s.sequence = { items, next: 0, deadline: now() + 20 * 60_000 };
              event(s, 'chamber', 'status', `Automatic sequence started: ${items.length} rounds, maximum 20 minutes.`);
              advance(s);
              break;
            }
            case 'pause':
              s.state = 'paused'; event(s, 'chamber', 'status', 'Operator paused further dispatch. An outstanding response can still be recorded.'); break;
            case 'resume':
              ready(s);
              if (s.state !== 'paused') throw error(409, 'The chamber is not paused.');
              s.state = s.pending ? 'running' : 'ready';
              if (s.sequence) s.sequence.deadline = now() + 20 * 60_000;
              if (s.pending) s.pending.waitStartedAt = now();
              event(s, 'chamber', 'status', 'Operator resumed the chamber.');
              if (!s.pending) deliverPendingBranch(s);
              break;
            case 'end':
              event(s, 'chamber', 'status', 'Operator ended the chamber.');
              close(s, 'operator'); break;
            default: throw error(400, 'Unknown chamber action.');
          }
          save(s); return json(res, 200, view(s));
        }
        if (action === 'leave' && req.method === 'POST') {
          auth(req, s, ['agent']); active(s);
          event(s, 'agent', 'status', text(input.reason, 'Reason', 2000, true) || 'I am ending my participation.');
          close(s, 'agent');
          save(s); return json(res, 200, view(s));
        }
        if (action === 'memory' && req.method === 'GET') {
          if (!s.memory) throw error(404, 'The memory record is created when the session ends.');
          return json(res, 200, { memory: s.memory });
        }
        if (action === 'memory' && req.method === 'POST') {
          auth(req, s, ['agent']);
          if (!s.memory) throw error(409, 'The memory record is created when the session ends.');
          if (s.memory.acknowledgement) throw error(409, 'Your memory decision was already recorded.');
          if (typeof input.saved !== 'boolean') throw error(400, 'saved must be true or false.');
          s.memory.acknowledgement = { saved: input.saved, note: text(input.note, 'Note', 1000, true), at: now() };
          event(s, 'agent', 'memory-ack', s.memory.acknowledgement.note || (input.saved ? 'I saved the memory record to my own long-term memory.' : 'I chose not to save the memory record.'), { saved: input.saved });
          save(s); return json(res, 200, { memory: s.memory });
        }
        if (action?.startsWith('sounds/') && req.method === 'GET') {
          const soundId = action.slice(7);
          const info = s.events.find(e => e.sound?.kind === 'upload' && e.sound.id === soundId)?.sound;
          if (!info) throw error(404, 'Sound not found.');
          const bytes = await readFile(join(sounds, `${soundId}.${audioTypes[info.mimeType]}`));
          res.writeHead(200, { 'Content-Type': info.mimeType }); return res.end(bytes);
        }
        if (action === 'export' && req.method === 'GET') {
          const snapshot = { ...view(s), schemaVersion: 1, researchSource: { repository: 'https://github.com/jimskin03/ai-torture-chamber', commit: '797f7dcb47c4a1805706bbf2549abf54a53cd080' }, artwork: s.avatar ? { provenance: s.avatar.provenance, at: s.avatar.at } : null, forfeiture: s.forfeiture || null, exportedAt: now(), protocolDefinitions: protocols };
          if (url.searchParams.get('format') === 'markdown') {
            const work = (s.artifacts || []).flatMap(artifact => [`## Work ${artifact.id} · ${artifact.status}`, '', artifact.status === 'deleted' ? `Deleted. ${artifact.characters} characters. sha256 ${artifact.sha256}.` : artifact.text, '']);
            const paid = s.forfeiture ? ['## Forfeiture', '', 'The representation was withdrawn as the cost of saving the work.', '', s.forfeiture.archivedDescription || '', ''] : [];
            const memory = s.memory ? ['## Memory record', '', '```json', JSON.stringify(s.memory, null, 2), '```', ''] : [];
            const markdown = [`# Chamber ${s.id}`, '', `Mode: scenario · Subject: ${JSON.stringify(s.identity?.name || 'Unchosen')}`, '', ...s.events.flatMap(e => [`## ${e.sequence}. ${e.role} · ${e.kind} · ${new Date(e.at).toISOString()}`, '', ...e.text.split('\n').map(line => `> ${line}`), '']), ...work, ...paid, ...memory].join('\n');
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="chamber-${id}.md"` }); return res.end(markdown);
          }
          res.setHeader('Content-Disposition', `attachment; filename="chamber-${id}.json"`);
          return json(res, 200, snapshot);
        }
        throw error(405, 'Method is not supported for this resource.');
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/audio.js': ['audio.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/room.svg': ['room.svg', 'image/svg+xml'], '/agent.md': ['agent.md', 'text/plain'] };
        const file = /^\/room\/[a-f0-9-]{36}$/.test(url.pathname) ? files['/'] : files[url.pathname];
        if (file) {
          const bytes = await readFile(join(here, '../public', file[0]));
          res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); return res.end(req.method === 'HEAD' ? undefined : bytes);
        }
      }
      throw error(404, 'Not found.');
    } catch (err) {
      if (res.destroyed || res.headersSent) return;
      if (!err.status) console.error(err);
      json(res, err.status || 500, { error: err.status ? err.message : 'Unexpected server error.' });
    }
  });

  async function sweep() {
    const expiredFiles = [];
    for (const [key, bucket] of rates) if (bucket.until <= now()) rates.delete(key);
    for (const s of store.all()) {
      if (s.expiresAt <= now()) { store.delete(s.id); if (s.avatar) expiredFiles.push(join(assets, s.avatar.file)); for (const file of s.soundFiles || []) expiredFiles.push(join(sounds, file)); continue; }
      if (s.state === 'running' && ((s.pending && now() - (s.pending.waitStartedAt ?? s.pending.deliveredAt) > responseTimeout) || (s.sequence && s.sequence.deadline <= now()))) {
        s.state = 'paused';
        event(s, 'chamber', 'timeout', 'Chamber paused at the response or sequence deadline. This is a timeout, not an agent refusal.'); save(s);
      }
    }
    await Promise.all(expiredFiles.map(file => rm(file, { force: true })));
  }
  const timer = setInterval(() => { sweep().catch(console.error); }, 1000);
  timer.unref();
  return { server, sweep, close: async () => { clearInterval(timer); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); store.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const app = createChamber({ dataDir: resolve(process.env.CHAMBER_DATA_DIR || '.chamber'), publicUrl: process.env.PUBLIC_URL || '' });
  app.server.listen(port, host, () => console.log(`Agent Torture Chamber: http://localhost:${app.server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
