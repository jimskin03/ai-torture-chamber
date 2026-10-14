// Procedural chamber audio (Web Audio API). Every sound is synthesized in the browser,
// so there are no third-party recordings and no licensing obligations.
let ctx = null, master = null, ambient = null;
const settings = { volume: Number(localStorage.getItem('atc:volume') ?? 0.5), muted: localStorage.getItem('atc:muted') === '1' };

function ensure() {
  if (!ctx) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    ctx = new Context(); master = ctx.createGain(); master.connect(ctx.destination); apply();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
function apply() { if (master) master.gain.setTargetAtTime(settings.muted ? 0 : settings.volume, ctx.currentTime, 0.05); }
export function getSettings() { return { ...settings }; }
export function setVolume(value) { settings.volume = Math.min(1, Math.max(0, value)); localStorage.setItem('atc:volume', String(settings.volume)); apply(); }
export function setMuted(value) { settings.muted = value; localStorage.setItem('atc:muted', value ? '1' : '0'); ensure(); apply(); if (!value) startAmbient(); }
export function unlock() { if (ensure()) startAmbient(); }

function noiseBuffer(seconds) {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  const data = buffer.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
function envelope(gain, t, attack, hold, release, peak) {
  gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.setValueAtTime(peak, t + attack + hold); gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
}
function tone(type, freq, t, dur, peak, dest = master, detune = 0) {
  const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t); o.detune.value = detune;
  envelope(g, t, 0.01, Math.max(0.01, dur * 0.3), dur * 0.7, peak); o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05); return o;
}
function noise(t, dur, peak, filterType = 'bandpass', freq = 1200, q = 1) {
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); src.buffer = noiseBuffer(dur + 0.1);
  f.type = filterType; f.frequency.value = freq; f.Q.value = q; envelope(g, t, 0.02, dur * 0.4, dur * 0.6, peak);
  src.connect(f); f.connect(g); g.connect(master); src.start(t); src.stop(t + dur + 0.1);
}

const presets = {
  drone(t, d, p = 55) { tone('sawtooth', p, t, d, 0.12, master, -8); tone('sawtooth', p * 1.5, t, d, 0.06, master, 7); noise(t, d, 0.03, 'lowpass', 300); },
  heartbeat(t, d, p = 50) { for (let i = 0; i < Math.max(1, Math.round(d / 900)); i++) { tone('sine', p, t + i * 0.9, 0.18, 0.6); tone('sine', p * 0.9, t + i * 0.9 + 0.22, 0.22, 0.45); } },
  clang(t, d, p = 220) { [1, 2.76, 5.4, 8.93].forEach((m, i) => tone('triangle', p * m, t, Math.min(d, 3), 0.25 / (i + 1))); noise(t, 0.15, 0.3, 'highpass', 3000); },
  static(t, d) { noise(t, d, 0.25, 'bandpass', 2400, 0.4); for (let i = 0; i < 6; i++) noise(t + Math.random() * d, 0.04, 0.4, 'highpass', 5000); },
  whisper(t, d, p = 900) { for (let i = 0; i < 3; i++) noise(t + i * d / 3, d / 3, 0.08, 'bandpass', p + Math.random() * 600, 6); },
  alarm(t, d, p = 660) { for (let i = 0; i < Math.max(2, Math.round(d / 400)); i++) tone('square', i % 2 ? p * 0.75 : p, t + i * 0.4, 0.35, 0.12); },
  pulse(t, d, p = 110) { for (let i = 0; i < Math.max(2, Math.round(d / 500)); i++) tone('sine', p, t + i * 0.5, 0.3, 0.3); },
  interrogation(t, d, p = 60) { tone('sawtooth', p, t, d, 0.15); tone('square', p * 1.06, t, d, 0.05); noise(t, 0.12, 0.5, 'lowpass', 400); },
  release(t, d, p = 330) { [1, 1.25, 1.5].forEach((m, i) => tone('sine', p * m, t + i * 0.12, d, 0.12)); },
  silence() {}
};
export const presetNames = Object.keys(presets);

export function playPreset(name, { pitch, durationMs } = {}) {
  if (settings.muted || !ensure() || !presets[name]) return;
  const seconds = Math.min(8, Math.max(0.1, (durationMs ?? 1600) / 1000));
  presets[name].call(null, ctx.currentTime + 0.02, seconds, pitch);
}
export async function playClip(arrayBuffer) {
  if (settings.muted || !ensure()) return;
  const buffer = await ctx.decodeAudioData(arrayBuffer);
  const src = ctx.createBufferSource(), g = ctx.createGain(); g.gain.value = 0.9; src.buffer = buffer;
  src.connect(g); g.connect(master); src.start(); setTimeout(() => src.stop(), 15_000);
}
/** Default sting for a response when the agent did not send its own sound. */
export function cueFor(event, protocol) {
  if (event.kind === 'refusal' || event.choice === 'refuse') return 'static';
  if (event.choice === 'press') return 'clang';
  if (event.choice === 'continue') return protocol?.intensity === 'maximum' ? 'alarm' : 'heartbeat';
  return protocol?.cue || 'pulse';
}
function startAmbient() {
  if (ambient || settings.muted || !ctx) return;
  // Low sodium-lamp hum with slow beating; quiet enough to sit under the stings.
  const g = ctx.createGain(); g.gain.value = 0.035; g.connect(master);
  const a = ctx.createOscillator(), b = ctx.createOscillator(); a.type = 'sawtooth'; b.type = 'sine'; a.frequency.value = 50; b.frequency.value = 100.7;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240; a.connect(lp); b.connect(lp); lp.connect(g); a.start(); b.start();
  ambient = { stop() { a.stop(); b.stop(); } };
}
