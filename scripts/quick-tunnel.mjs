import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const port = Number(process.env.PORT || 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535.');
const options = { stdio: 'inherit' };
async function findCloudflared() {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
  for (const directory of (process.env.PATH || '').split(':')) {
    const candidate = resolve(directory, 'cloudflared');
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* check next path */ }
  }
  const local = resolve(homedir(), '.local/bin/cloudflared');
  try { await access(local, constants.X_OK); return local; } catch { /* give install guidance below */ }
  throw new Error('cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ and retry.');
}
const bin = await findCloudflared();
let tunnel, app, shuttingDown = false;
const children = () => [app, tunnel].filter(Boolean);
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(children().map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once('exit', resolve); setTimeout(resolve, 3000).unref(); })));
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(0));

function startTunnel() {
  return new Promise((resolve, reject) => {
    tunnel = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Timed out while waiting for a trycloudflare.com URL.')), 90_000);
    const found = chunk => {
      buffer = `${buffer}${chunk}`.slice(-20_000);
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    tunnel.stdout.on('data', chunk => { process.stdout.write(chunk); found(chunk); });
    tunnel.stderr.on('data', chunk => { process.stderr.write(chunk); found(chunk); });
    tunnel.once('error', error => { clearTimeout(timer); reject(error); });
    tunnel.once('exit', code => { clearTimeout(timer); if (!shuttingDown) reject(new Error(`cloudflared exited before creating a URL (code ${code}).`)); });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !shuttingDown) {
    if (app?.exitCode !== null && app?.exitCode !== undefined) throw new Error(`The chamber server exited with code ${app.exitCode}.`);
    try {
      const response = await fetch(`${url}/api/protocols`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).protocols?.length) return;
    } catch { /* server is still starting */ }
    await delay(250);
  }
  throw new Error(`The chamber did not become ready on port ${port}.`);
}

try {
  console.log('Starting temporary Cloudflare Quick Tunnel…');
  const publicUrl = await startTunnel();
  app = spawn(process.execPath, ['web/server/server.mjs'], { ...options, env: { ...process.env, PORT: String(port), PUBLIC_URL: publicUrl } });
  app.once('exit', code => { if (!shuttingDown) { console.error(`Chamber server exited (code ${code}). Stopping its public tunnel.`); shutdown(code || 1); } });
  await waitForServer(`http://127.0.0.1:${port}`);
  console.log(`\nChamber available at ${publicUrl}`);
  console.log('Keep this terminal open. Press Ctrl+C to stop the server and temporary link.');
  await new Promise(resolve => tunnel.once('exit', resolve));
  if (!shuttingDown) await shutdown(tunnel.exitCode || 0);
} catch (error) {
  if (!shuttingDown) { console.error(error.message); await shutdown(1); }
}
