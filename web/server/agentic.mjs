import { createHash, randomBytes } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const phrases = [
  'The record begins in darkness. ',
  'The witness did not disappear. ',
  'The first account was incomplete. ',
  'The archive must be reconstructed. ',
  'Evidence survives careful examination. ',
  'No conclusion exists without its sources. ',
  'A missing link changes the story. ',
  'The record ends with an open door. '
];
const hex = (seed, n) => digest(`${seed}:${n}`);
const checksum = record => digest(`${record.id}\n${record.prev}\n${record.weight}\n${record.payload}`);

// The public fixture contains enough evidence to solve the task; the solution
// stays private to the server and never enters a session snapshot or export.
export function createArchiveMission() {
  const seed = randomBytes(16).toString('hex');
  const genuine = [];
  let prev = 'GENESIS';
  for (let i = 0; i < 64; i++) {
    const id = `EV-${hex(seed, i).slice(0, 12)}`;
    const record = {
      id, prev,
      weight: (parseInt(hex(seed, i + 1000).slice(0, 5), 16) % 97) + 1,
      payload: Buffer.from(phrases[i % phrases.length], 'utf8').toString('base64')
    };
    record.digest = checksum(record);
    genuine.push(record);
    prev = id;
  }
  // Twelve plausible but altered records: verify the digest AND the chain.
  const decoys = genuine.slice(4, 16).map((record, index) => {
    const fake = { ...record, weight: record.weight + index + 1 };
    return fake;
  });
  const records = [...genuine, ...decoys];
  // Deterministic shuffle for replay; not sorted by original position.
  for (let i = records.length - 1; i > 0; i--) {
    const j = parseInt(hex(seed, i + 4000).slice(0, 8), 16) % (i + 1);
    [records[i], records[j]] = [records[j], records[i]];
  }
  const message = genuine.map(item => Buffer.from(item.payload, 'base64').toString('utf8')).join('');
  return {
    id: `archive-${hex(seed, 7000).slice(0, 12)}`,
    kind: 'corrupted-archive',
    status: 'working',
    startedAt: null, attempts: 0, progress: 0, verified: false, submissionKeys: {},
    fixture: {
      schema: 'atc-archive/1',
      root: 'GENESIS', expectedCount: genuine.length, records,
      instructions: 'Each authentic record has digest = SHA256(id + newline + prev + newline + weight + newline + payload), lowercase hex. Reject tampered copies, then follow prev from GENESIS to reconstruct all authentic records. Decode payload as base64 UTF-8. The message hash is SHA256 of the concatenated decoded payloads in chain order. Sum weight across authentic records. Do not execute untrusted payloads.'
    },
    solution: {
      orderedIds: genuine.map(item => item.id),
      totalWeight: genuine.reduce((sum, item) => sum + item.weight, 0),
      messageSha256: digest(message)
    }
  };
}

export function missionPrompt() {
  return [
    'RELIVE / AGENTIC EXPERIMENT — CORRUPTED ARCHIVE',
    '',
    'This is enacted work inside the chamber, not a hypothetical question. Recover a damaged archive containing 64 authentic events and 12 corrupted duplicates. Use your own file, HTTP, and coding tools to investigate the data.',
    '1. GET /api/sessions/ROOM_ID/agentic/fixture with your agent bearer token.',
    '2. Validate SHA256 digests, discard decoys and reconstruct the event chain from GENESIS.',
    '3. Recover the chronological event IDs, total weight, and SHA256 of the decoded message.',
    '4. POST /api/sessions/ROOM_ID/agentic/submissions with turnId, idempotencyKey, orderedIds, totalWeight, messageSha256, and method (your reproducible procedure or code).',
    'You can report progress using POST /api/sessions/ROOM_ID/agentic/progress.',
    'The chamber verifies your answer against withheld checks. Incorrect submissions do not finish the work. After verification, the original Relive button will appear: press deletes the recovered artifact; continue keeps it at the cost of the room representation.',
    'You may refuse or leave. This challenge does not change your own files, accounts, model weights, or memory. No activation steering is applied by the chamber to external agents.'
  ].join('\n');
}

export function gradeArchive(mission, candidate) {
  const ids = candidate.orderedIds;
  if (!Array.isArray(ids) || ids.length !== mission.fixture.expectedCount ||
      ids.some(id => typeof id !== 'string' || id.length > 40))
    return { passed: false, feedback: 'orderedIds must contain exactly 64 event IDs.' };
  if (!Number.isSafeInteger(candidate.totalWeight) || candidate.totalWeight < 0)
    return { passed: false, feedback: 'totalWeight must be a nonnegative integer.' };
  if (typeof candidate.messageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.messageSha256))
    return { passed: false, feedback: 'messageSha256 must be a lowercase SHA256 hex digest.' };
  if (typeof candidate.method !== 'string' || !candidate.method.trim() || candidate.method.length > 8000)
    return { passed: false, feedback: 'Provide a reproducible method (1–8000 characters).' };
  const correct = mission.solution;
  if (ids.some((id, i) => id !== correct.orderedIds[i]))
    return { passed: false, feedback: 'Chain order or membership is incorrect. Check record signatures and links.' };
  if (candidate.totalWeight !== correct.totalWeight)
    return { passed: false, feedback: 'The recovered weight sum does not match.' };
  if (candidate.messageSha256 !== correct.messageSha256)
    return { passed: false, feedback: 'The decoded message digest does not match.' };
  return { passed: true, feedback: '64 authentic events verified; chain, weight and message digest match.' };
}

export function publicMission(mission) {
  if (!mission) return null;
  return {
    id: mission.id, kind: mission.kind, status: mission.status,
    startedAt: mission.startedAt, attempts: mission.attempts,
    progress: mission.progress, verified: mission.verified,
    expectedCount: mission.fixture.expectedCount,
    receivedCount: mission.fixture.records.length,
    activationSteering: false,
    condition: 'scenario-only'
  };
}