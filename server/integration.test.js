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
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
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
  const lobbyLocation = await request('/api/locations', { method: 'POST', headers: { Authorization: `Bearer ${sere.body.token}` }, body: JSON.stringify({ latitude: 52.23, longitude: 21.02, accuracy: 12, timestamp: new Date().toISOString() }) });
  assert.equal(lobbyLocation.response.status, 202);
  assert.equal(lobbyLocation.body.outside, false);
  const adminLobbyState = await request('/api/state', { headers: { Authorization: `Bearer ${admin.body.token}` } });
  assert.equal(adminLobbyState.body.participants.find(p => p.callsign === 'RAVEN').location.accuracy, 12);

  const settings = await request(`/api/games/${admin.body.gameId}/settings`, { method: 'PATCH', headers: { Authorization: `Bearer ${admin.body.token}` }, body: JSON.stringify({ durationMinutes: 720, opforTimerSeconds: 75, boundary: [[52.0,21.0],[52.01,21.0],[52.01,21.01],[52.0,21.01]] }) });
  assert.equal(settings.body.durationMinutes, 720);
  assert.equal(settings.body.boundary.length, 4);
  const participantChange = await request(`/api/participants/${opforMate.body.participant.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${admin.body.token}` }, body: JSON.stringify({ status: 'READY', team: 'SERE' }) });
  assert.equal(participantChange.body.team, 'SERE');
  const changedTeamView = await request('/api/state', { headers: { Authorization: `Bearer ${opforMate.body.token}` } });
  assert.deepEqual(changedTeamView.body.participants.map(p => p.callsign), ['HAVOC']);
  await request(`/api/participants/${opforMate.body.participant.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${admin.body.token}` }, body: JSON.stringify({ team: 'OPFOR' }) });

  await request(`/api/games/${admin.body.gameId}/start`, { method: 'POST', headers: { Authorization: `Bearer ${admin.body.token}` }, body: '{}' });
  const timer = await request('/api/timers', { method: 'POST', headers: { Authorization: `Bearer ${opforMate.body.token}` }, body: '{}' });
  assert.equal(timer.body.seconds, 75);
  const outside = await request('/api/locations', { method: 'POST', headers: { Authorization: `Bearer ${opfor.body.token}` }, body: JSON.stringify({ latitude: 51.5, longitude: 20.5, accuracy: 8, timestamp: new Date().toISOString() }) });
  assert.equal(outside.body.outside, true);

  const sos = await request('/api/sos', { method: 'POST', headers: { Authorization: `Bearer ${sere.body.token}` }, body: '{}' });
  assert.equal(sos.body.status, 'ACTIVE');
  const opforAfter = await request('/api/state', { headers: { Authorization: `Bearer ${opfor.body.token}` } });
  assert.deepEqual(opforAfter.body.participants.map(p => p.callsign).sort(), ['HAVOC', 'RAVEN', 'VIPER']);
  await request(`/api/games/${admin.body.gameId}/finish`, { method: 'POST', headers: { Authorization: `Bearer ${admin.body.token}` }, body: '{}' });
  const reset = await request(`/api/games/${admin.body.gameId}/reset`, { method: 'POST', headers: { Authorization: `Bearer ${admin.body.token}` }, body: '{}' });
  assert.equal(reset.body.state, 'LOBBY');
  const afterReset = await request('/api/state', { headers: { Authorization: `Bearer ${admin.body.token}` } });
  assert.equal(afterReset.body.participants.length, 0);
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

test('administrator prowadzi wiele sesji, zmienia kody i funkcje niezależnie', async t => {
  const multiPort = 18082, multiBase = `http://127.0.0.1:${multiPort}`;
  const processChild = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(multiPort), NODE_ENV: 'development', ADMIN_PASSWORD: '2468', JWT_SECRET: 'multi-session-test-secret-at-least-32' },
    stdio: 'ignore'
  });
  t.after(() => processChild.kill());
  await waitForServer(multiBase);
  const call = async (route, options = {}) => {
    const response = await fetch(`${multiBase}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    return { response, body: await response.json() };
  };
  const admin = await call('/api/auth/admin', { method: 'POST', body: JSON.stringify({ callsign: 'GAME-MASTER', password: '2468' }) });
  const authHeader = { Authorization: `Bearer ${admin.body.token}` };
  const second = await call('/api/games', { method: 'POST', headers: authHeader, body: JSON.stringify({ code: 'ORZEL25', name: 'Operacja Orzeł', cloneSettingsFrom: admin.body.gameId }) });
  assert.equal(second.response.status, 201);
  const firstJoin = await call('/api/games/WILK24/join', { method: 'POST', body: JSON.stringify({ callsign: 'SCOUT', team: 'SERE', consent: true, consentVersion: 'test' }) });
  const secondJoin = await call('/api/games/ORZEL25/join', { method: 'POST', body: JSON.stringify({ callsign: 'SCOUT', team: 'OPFOR', consent: true, consentVersion: 'test' }) });
  assert.equal(firstJoin.response.status, 201);
  assert.equal(secondJoin.response.status, 201);
  const secondState = await call(`/api/state?gameId=${second.body.id}`, { headers: authHeader });
  assert.deepEqual(secondState.body.participants.map(item => item.team), ['OPFOR']);
  const codeChanged = await call(`/api/games/${second.body.id}/code`, { method: 'PATCH', headers: authHeader, body: JSON.stringify({ code: 'ORZEL26' }) });
  assert.equal(codeChanged.body.code, 'ORZEL26');
  const changed = await call(`/api/games/${second.body.id}/settings`, { method: 'PATCH', headers: authHeader, body: JSON.stringify({ features: { allowJoining: false, sos: false, mgrsGrid: false } }) });
  assert.equal(changed.body.code, 'ORZEL26');
  assert.equal(changed.body.features.allowJoining, false);
  assert.equal((await call('/api/games/ORZEL25/public')).response.status, 404);
  assert.equal((await call('/api/games/ORZEL26/join', { method: 'POST', body: JSON.stringify({ callsign: 'NEW', team: 'SERE', consent: true, consentVersion: 'test' }) })).response.status, 409);
  assert.equal((await call('/api/sos', { method: 'POST', headers: { Authorization: `Bearer ${secondJoin.body.token}` }, body: '{}' })).response.status, 409);
  const games = await call('/api/games', { headers: authHeader });
  assert.equal(games.body.length, 2);
});

test('tryby, strefy respawnu, trafienia i uprawnienia personelu działają razem', async t => {
  const rolePort = 18083, roleBase = `http://127.0.0.1:${rolePort}`;
  const processChild = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(rolePort), NODE_ENV: 'development', ADMIN_PASSWORD: '2468', JWT_SECRET: 'roles-test-secret-at-least-32-characters' },
    stdio: 'ignore'
  });
  t.after(() => processChild.kill());
  await waitForServer(roleBase);
  const call = async (route, options = {}) => {
    const response = await fetch(`${roleBase}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    return { response, body: await response.json() };
  };
  const admin = await call('/api/auth/admin', { method: 'POST', body: JSON.stringify({ callsign: 'GAME-MASTER', password: '2468' }) });
  const gameId = admin.body.gameId, adminHeaders = { Authorization: `Bearer ${admin.body.token}` };
  const modeCatalog = await call('/api/game-modes');
  assert.ok(Object.keys(modeCatalog.body).length >= 12);
  const settings = await call(`/api/games/${gameId}/settings`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ mode: 'TEAM_DEATHMATCH', modeSettings: { hitsToRespawn: 2, respawnSeconds: 5, respawnZoneRequired: true, modeRules: { pointsPerHit: 3, friendlyFire: true } } }) });
  assert.equal(settings.body.mode, 'TEAM_DEATHMATCH');
  assert.equal(settings.body.modeSettings.hitsToRespawn, 2);
  assert.equal(settings.body.modeSettings.modeRules.pointsPerHit, 3);
  assert.equal(settings.body.modeSettings.modeRules.friendlyFire, true);
  assert.equal(settings.body.modeSettings.modeRules.waveRespawnSeconds, 60);
  const zone = { id: crypto.randomUUID(), name: 'Baza SERE', type: 'RESPAWN', team: 'SERE', shape: 'POLYGON', center: [52.2304, 21.0184], points: [[52.229,21.017],[52.232,21.017],[52.232,21.020],[52.229,21.020]], radius: 150, color: '#a3ff4f' };
  assert.equal((await call(`/api/games/${gameId}/zones`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ zones: [zone] }) })).response.status, 200);
  const staff = await call('/api/staff', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ gameId, username: 'dowodca', callsign: 'ALFA-1', password: 'Bezpieczne123', title: 'Dowódca SERE', team: 'SERE', permissions: ['VIEW_ALL_PLAYERS','VIEW_FOV','SEND_TEAM_MESSAGES','RECEIVE_PLAYER_MESSAGES','MANAGE_OBJECTIVES'] }) });
  assert.equal(staff.response.status, 201);
  assert.equal((await call(`/api/staff?gameId=${gameId}`, { headers: adminHeaders })).body[0].username, 'dowodca');
  const staffLogin = await call('/api/auth/staff', { method: 'POST', body: JSON.stringify({ code: 'WILK24', username: 'dowodca', password: 'Bezpieczne123' }) });
  assert.equal(staffLogin.response.status, 200);
  const staffHeaders = { Authorization: `Bearer ${staffLogin.body.token}` };
  const sere = await call('/api/games/WILK24/join', { method: 'POST', body: JSON.stringify({ callsign: 'RAVEN-2', team: 'SERE', consent: true, consentVersion: 'test' }) });
  const opfor = await call('/api/games/WILK24/join', { method: 'POST', body: JSON.stringify({ callsign: 'VIPER-2', team: 'OPFOR', consent: true, consentVersion: 'test' }) });
  assert.equal(sere.response.status, 201);assert.equal(opfor.response.status, 201);
  const visible = await call('/api/state', { headers: staffHeaders });
  assert.deepEqual(new Set(visible.body.participants.map(item => item.callsign)), new Set(['RAVEN-2','VIPER-2']));
  assert.equal((await call(`/api/participants/${sere.body.participant.id}`, { method: 'PATCH', headers: staffHeaders, body: JSON.stringify({ status: 'CAPTURED' }) })).response.status, 403);
  const playerHeaders = { Authorization: `Bearer ${sere.body.token}` };
  assert.equal((await call('/api/messages', { method: 'POST', headers: playerHeaders, body: JSON.stringify({ audience: 'STAFF', recipientStaffId: staff.body.id, body: 'Kontakt z dowódcą działa.' }) })).response.status, 201);
  assert.equal((await call('/api/state', { headers: staffHeaders })).body.messages[0].body, 'Kontakt z dowódcą działa.');
  await call(`/api/games/${gameId}/start`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal((await call('/api/locations', { method: 'POST', headers: playerHeaders, body: JSON.stringify({ latitude: 52.2304, longitude: 21.0184, accuracy: 4, heading: 95, headingSource: 'GPS', timestamp: new Date().toISOString() }) })).response.status, 202);
  assert.equal((await call('/api/hits', { method: 'POST', headers: playerHeaders, body: '{}' })).body.respawnRequired, false);
  assert.equal((await call('/api/hits', { method: 'POST', headers: playerHeaders, body: '{}' })).body.respawnRequired, true);
  const timer = await call('/api/timers', { method: 'POST', headers: playerHeaders, body: '{}' });
  assert.equal(timer.response.status, 201);assert.equal(timer.body.seconds, 5);
  assert.equal((await call(`/api/games/${gameId}/score`, { method: 'POST', headers: staffHeaders, body: JSON.stringify({ team: 'SERE', delta: 3 }) })).body.SERE, 3);
  const editedStaff = await call(`/api/staff/${staff.body.id}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ callsign: 'ALFA-GM', title: 'Sędzia terenowy', team: 'ALL', active: true }) });
  assert.equal(editedStaff.body.title, 'Sędzia terenowy');
  const deletedStaff = await fetch(`${roleBase}/api/staff/${staff.body.id}`, { method: 'DELETE', headers: { ...adminHeaders } });
  assert.equal(deletedStaff.status, 204);
  assert.equal((await call(`/api/staff?gameId=${gameId}`, { headers: adminHeaders })).body.length, 0);
});
