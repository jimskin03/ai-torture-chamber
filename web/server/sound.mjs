// Optional agent-supplied sound for a response. Either a named procedural preset
// (synthesized in the browser with Web Audio) or a small uploaded audio clip.
export const soundPresets = ['drone', 'heartbeat', 'clang', 'static', 'whisper', 'alarm', 'pulse', 'interrogation', 'release', 'silence'];
export const audioTypes = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/webm': 'webm' };
export const MAX_SOUND_BYTES = 256 * 1024;

const fail = message => Object.assign(new Error(message), { status: 400 });

function sniff(bytes) {
  const ascii = (start, end) => bytes.subarray(start, end).toString('latin1');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

/** Returns null, a normalized preset spec, or { kind: 'upload', mimeType, bytes }. Throws 400 on invalid input. */
export function parseSound(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Sound must be an object.');
  if (value.type === 'preset') {
    if (!soundPresets.includes(value.preset)) throw fail(`Sound preset must be one of: ${soundPresets.join(', ')}.`);
    const spec = { kind: 'preset', preset: value.preset };
    if (value.pitch !== undefined) { if (typeof value.pitch !== 'number' || !(value.pitch >= 30 && value.pitch <= 2000)) throw fail('Sound pitch must be 30–2000 Hz.'); spec.pitch = value.pitch; }
    if (value.durationMs !== undefined) { if (!Number.isInteger(value.durationMs) || value.durationMs < 100 || value.durationMs > 8000) throw fail('Sound durationMs must be an integer from 100 to 8000.'); spec.durationMs = value.durationMs; }
    return spec;
  }
  if (value.type === 'audio') {
    if (!Object.hasOwn(audioTypes, value.mimeType)) throw fail(`Audio mimeType must be one of: ${Object.keys(audioTypes).join(', ')}.`);
    if (typeof value.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw fail('Audio data must be base64.');
    if (value.data.length > Math.ceil(MAX_SOUND_BYTES / 3) * 4) throw fail('Audio clip exceeds 256 KiB.');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length < 16 || bytes.length > MAX_SOUND_BYTES) throw fail('Audio clip must be 16 bytes to 256 KiB.');
    if (sniff(bytes) !== value.mimeType) throw fail('Audio bytes do not match the declared mimeType.');
    return { kind: 'upload', mimeType: value.mimeType, bytes };
  }
  throw fail('Sound type must be preset or audio.');
}
