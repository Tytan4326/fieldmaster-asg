import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 18080;
const base = `http://127.0.0.1:${port}`;
let child;

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

async function waitForServer(url = base) {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Serwer testowy nie uruchomił się.');
}

test('pełny scenariusz API zachowuje role, timer i SOS', async t => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', ADMIN_PASSWORD: '2468', JWT_SECRET: 'integration-test-secret-at-least-32-chars' },
    stdio: 'ignore'
  });
  t.after(() => child?.kill());
  await waitForServer();

  const admin = await request('/api/auth/admin', { method: 'POST', body: JSON.stringify({ callsign: 'GAME-MASTER', password: '2468' }) });
  assert.equal(admin.response.status, 200);

  const opfor = await request('/api/games/WILK24/join', { method: 'POST', body: JSON.stringify({ callsign: 'VIPER', team: 'OPFOR', consent: true, consentVersion: 'test' }) });
  const opforMate = await request('/api/games/WILK24/join', { method: 'POST', body: JSON.stringify({ callsign: 'HAVOC', team: 'OPFOR', consent: true, consentVersion: 'test' }) });
  const sere = await request('/api/games/WILK24/join', { method: 'POST', body: JSON.stringify({ callsign: 'RAVEN', team: 'SERE', consent: true, consentVersion: 'test' }) });
  assert.equal(sere.response.status, 201);

  const duplicate = await request('/api/games/WILK24/join', { method: 'POST', body: JSON.stringify({ callsign: 'RAVEN', team: 'SERE', consent: true, consentVersion: 'test' }) });
  assert.equal(duplicate.response.status, 409);

  const opforBefore = await request('/api/state', { headers: { Authorization: `Bearer ${opfor.body.token}` } });
  assert.deepEqual(opforBefore.body.participants.map(p => p.callsign).sort(), ['HAVOC', 'VIPER']);
  const sereBefore = await request('/api/state', { headers: { Authorization: `Bearer ${sere.body.token}` } });
  assert.deepEqual(sereBefore.body.participants.map(p => p.callsign), ['RAVEN']);

  const settings = await request(`/api/games/${admin.body.gameId}/settings`, { method: 'PATCH', headers: { Authorization: `Bearer ${admin.body.token}` }, body: JSON.stringify({ durationMinutes: 720, opforTimerSeconds: 75, boundary: [[52.0,21.0],[52.01,21.0],[52.01,21.01],[52.0,21.01]] }) });
  assert.equal(settings.body.durationMinutes, 720);
  assert.equal(settings.body.boundary.length, 4);
  const participantChange = await request(`/api/participants/${opforMate.body.participant.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${admin.body.token}` }, body: JSON.stringify({ status: 'READY' }) });
  assert.equal(participantChange.body.status, 'READY');

  await request(`/api/games/${admin.body.gameId}/start`, { method: 'POST', headers: { Authorization: `Bearer ${admin.body.token}` }, body: '{}' });
  const timer = await request('/api/timers', { method: 'POST', headers: { Authorization: `Bearer ${opforMate.body.token}` }, body: '{}' });
  assert.equal(timer.body.seconds, 75);
  const outside = await request('/api/locations', { method: 'POST', headers: { Authorization: `Bearer ${opfor.body.token}` }, body: JSON.stringify({ latitude: 51.5, longitude: 20.5, accuracy: 8, timestamp: new Date().toISOString() }) });
  assert.equal(outside.body.outside, true);

  const sos = await request('/api/sos', { method: 'POST', headers: { Authorization: `Bearer ${sere.body.token}` }, body: '{}' });
  assert.equal(sos.body.status, 'ACTIVE');
  const opforAfter = await request('/api/state', { headers: { Authorization: `Bearer ${opfor.body.token}` } });
  assert.deepEqual(opforAfter.body.participants.map(p => p.callsign).sort(), ['HAVOC', 'RAVEN', 'VIPER']);
});

test('lokalny stan wraca po restarcie serwera', async t => {
  const persistencePort = 18081;
  const persistenceBase = `http://127.0.0.1:${persistencePort}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldmaster-'));
  const dataFile = path.join(directory, 'state.json');
  let persistenceChild;
  const start = async () => {
    persistenceChild = spawn(process.execPath, ['server/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(persistencePort), NODE_ENV: 'development', ADMIN_PASSWORD: '2468', JWT_SECRET: 'persistence-test-secret-at-least-32', DATA_FILE: dataFile },
      stdio: 'ignore'
    });
    await waitForServer(persistenceBase);
  };
  t.after(() => { persistenceChild?.kill(); fs.rmSync(directory, { recursive: true, force: true }); });

  await start();
  const joined = await fetch(`${persistenceBase}/api/games/WILK24/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callsign: 'PERSIST', team: 'SERE', consent: true, consentVersion: 'test' }) });
  assert.equal(joined.status, 201);
  await new Promise(resolve => setTimeout(resolve, 500));
  persistenceChild.kill();
  await new Promise(resolve => persistenceChild.once('exit', resolve));

  await start();
  const admin = await (await fetch(`${persistenceBase}/api/auth/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callsign: 'GAME-MASTER', password: '2468' }) })).json();
  const restored = await (await fetch(`${persistenceBase}/api/state`, { headers: { Authorization: `Bearer ${admin.token}` } })).json();
  assert.deepEqual(restored.participants.map(p => p.callsign), ['PERSIST']);
});
