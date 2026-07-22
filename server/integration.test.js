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
  assert.equal((await call('/api/locations', { method: 'POST', headers: playerHeaders, body: JSON.stringify({ latitude: 52.2304, longitude: 21.0184, accuracy: 4, heading: 95, headingSource: 'CALIBRATED', timestamp: new Date().toISOString() }) })).response.status, 202);
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

test('prywatne wiadomości, statusy, trasy i strefy trybu są izolowane i trwałe', async t => {
  const featurePort = 18084, featureBase = `http://127.0.0.1:${featurePort}`;
  const processChild = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(featurePort), NODE_ENV: 'development', ADMIN_PASSWORD: '2468', JWT_SECRET: 'feature-test-secret-at-least-32-characters' },
    stdio: 'ignore'
  });
  t.after(() => processChild.kill());
  await waitForServer(featureBase);
  const call = async (route, options = {}) => {
    const response = await fetch(`${featureBase}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  };
  const admin = await call('/api/auth/admin', { method: 'POST', body: JSON.stringify({ callsign: 'GAME-MASTER', password: '2468' }) });
  const gameId = admin.body.gameId, adminHeaders = { Authorization: `Bearer ${admin.body.token}` };
  const createStaff = (username, callsign, permissions) => call('/api/staff', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ gameId, username, callsign, password: 'Bezpieczne123', title: 'Operator', team: 'ALL', permissions }) });
  const alpha = await createStaff('alpha', 'ALPHA', ['VIEW_ALL_PLAYERS','RECEIVE_PLAYER_MESSAGES','VIEW_COORDINATES','VIEW_PLAYER_STATUS','VIEW_REPLAY']);
  const bravo = await createStaff('bravo', 'BRAVO', ['VIEW_ALL_PLAYERS','RECEIVE_PLAYER_MESSAGES']);
  const login = async username => (await call('/api/auth/staff', { method: 'POST', body: JSON.stringify({ code: 'WILK24', username, password: 'Bezpieczne123' }) })).body.token;
  const alphaToken = await login('alpha'), bravoToken = await login('bravo');
  const alphaHeaders = { Authorization: `Bearer ${alphaToken}` }, bravoHeaders = { Authorization: `Bearer ${bravoToken}` };
  const sere = await call('/api/games/WILK24/join', { method: 'POST', body: JSON.stringify({ callsign: 'TRACKER', team: 'SERE', consent: true, consentVersion: 'test' }) });
  const opfor = await call('/api/games/WILK24/join', { method: 'POST', body: JSON.stringify({ callsign: 'DEFUSER', team: 'OPFOR', consent: true, consentVersion: 'test' }) });
  const playerHeaders = { Authorization: `Bearer ${sere.body.token}` };
  const opforHeaders = { Authorization: `Bearer ${opfor.body.token}` };
  await call('/api/messages', { method: 'POST', headers: playerHeaders, body: JSON.stringify({ audience: 'STAFF', recipientStaffId: alpha.body.id, body: 'Tylko dla Alpha' }) });
  assert.equal((await call('/api/state', { headers: alphaHeaders })).body.messages[0].body, 'Tylko dla Alpha');
  assert.equal((await call('/api/state', { headers: bravoHeaders })).body.messages.length, 0);
  const hidden = (await call('/api/state', { headers: bravoHeaders })).body.participants[0];
  assert.equal(hidden.status, 'HIDDEN');
  const mapLocked = await call(`/api/participants/${sere.body.participant.id}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ mapAccess: false }) });
  assert.equal(mapLocked.body.mapAccess, false);
  assert.equal((await call('/api/state', { headers: playerHeaders })).body.participants.find(item => item.id === sere.body.participant.id).mapAccess, false);

  const flag = { id: crypto.randomUUID(), name: 'Flaga OPFOR', type: 'FLAG', team: 'OPFOR', shape: 'CIRCLE', center: [52.2304,21.0184], radius: 100, color: '#ff9838' };
  const bomb = { id: crypto.randomUUID(), name: 'Most Alfa', type: 'BOMB_SITE', team: 'SERE', shape: 'CIRCLE', center: [52.2304,21.0184], radius: 100, color: '#ff493d', bombState: 'IDLE' };
  await call(`/api/games/${gameId}/settings`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ mode: 'BOMB_DEFUSAL', modeSettings: { modeRules: { plantSeconds: 1, defuseSeconds: 1, bombTimerSeconds: 5 } } }) });
  await call(`/api/games/${gameId}/zones`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ zones: [flag,bomb] }) });
  await call(`/api/games/${gameId}/start`, { method: 'POST', headers: adminHeaders, body: '{}' });
  await call('/api/locations', { method: 'POST', headers: playerHeaders, body: JSON.stringify({ latitude: 52.2304, longitude: 21.0184, accuracy: 4, heading: 45, headingSource: 'COMPASS', timestamp: new Date().toISOString() }) });
  await call('/api/locations', { method: 'POST', headers: opforHeaders, body: JSON.stringify({ latitude: 52.2304, longitude: 21.0184, accuracy: 4, heading: 225, headingSource: 'COMPASS', timestamp: new Date().toISOString() }) });
  const taken = await call(`/api/zones/${flag.id}/interact`, { method: 'POST', headers: playerHeaders, body: '{}' });
  assert.equal(taken.body.action, 'FLAG_TAKEN');
  const planting = await call(`/api/zones/${bomb.id}/interact`, { method: 'POST', headers: playerHeaders, body: '{}' });
  assert.equal(planting.body.action, 'BOMB_PLANT_STARTED');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await call('/api/state', { headers: adminHeaders })).body.game.zones.find(zone => zone.id === bomb.id).bombState, 'PLANTED');
  const defusing = await call(`/api/zones/${bomb.id}/interact`, { method: 'POST', headers: opforHeaders, body: '{}' });
  assert.equal(defusing.body.action, 'BOMB_DEFUSE_STARTED');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await call('/api/state', { headers: adminHeaders })).body.game.zones.find(zone => zone.id === bomb.id).bombState, 'DEFUSED');
  const replay = await call(`/api/games/${gameId}/replay`, { headers: adminHeaders });
  assert.equal(replay.response.status, 200);
  assert.ok(replay.body.tracks.length >= 2);
  assert.ok(replay.body.participants.some(item => item.callsign === 'TRACKER'));
  assert.equal((await call(`/api/games/${gameId}/replay`, { method: 'DELETE', headers: alphaHeaders })).response.status, 403);
  const cleared = await call(`/api/games/${gameId}/replay`, { method: 'DELETE', headers: adminHeaders });
  assert.ok(cleared.body.deleted >= 2);
  assert.equal((await call(`/api/games/${gameId}/replay`, { headers: adminHeaders })).body.tracks.length, 0);
});

test('drużyny, zdolności ról, presety i archiwum tworzą spójny przebieg operacji', async t => {
  const operationsPort=18085,operationsBase=`http://127.0.0.1:${operationsPort}`;
  const processChild=spawn(process.execPath,['server/index.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(operationsPort),NODE_ENV:'development',ADMIN_PASSWORD:'2468',JWT_SECRET:'operations-test-secret-at-least-32-characters'},stdio:'ignore'});
  t.after(()=>processChild.kill());await waitForServer(operationsBase);
  const call=async(route,options={})=>{const response=await fetch(`${operationsBase}${route}`,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const body=response.status===204?null:await response.json();return{response,body};};
  const admin=await call('/api/auth/admin',{method:'POST',body:JSON.stringify({callsign:'GAME-MASTER',password:'2468'})}),gameId=admin.body.gameId,adminHeaders={Authorization:`Bearer ${admin.body.token}`};
  const presets=await call('/api/presets');assert.ok(Object.keys(presets.body).length>=6);
  const applied=await call(`/api/games/${gameId}/presets/MILSIM_COMMAND/apply`,{method:'POST',headers:adminHeaders,body:'{}'});assert.equal(applied.body.mode,'SEARCH_RESCUE');assert.equal(applied.body.features.teamOperations,true);
  const stateBefore=(await call('/api/state',{headers:adminHeaders})).body,sereSquad=stateBefore.game.teams.find(team=>team.side==='SERE');
  const teams=stateBefore.game.teams.map(team=>team.id===sereSquad.id?{...team,mapSharing:'NONE',respawnSeconds:7,maxPlayers:3}:team);
  assert.equal((await call(`/api/games/${gameId}/teams`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({teams})})).response.status,200);
  const join=async callsign=>call('/api/games/WILK24/join',{method:'POST',body:JSON.stringify({callsign,team:'SERE',squadId:sereSquad.id,consent:true,consentVersion:'test'})});
  const commander=await join('COMMAND-1'),medic=await join('MEDIC-1'),target=await join('TARGET-1');
  assert.equal(commander.response.status,201);assert.equal((await join('TOO-MANY')).response.status,409);
  await call(`/api/participants/${commander.body.participant.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'COMMANDER'})});
  await call(`/api/participants/${medic.body.participant.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'MEDIC'})});
  const commanderHeaders={Authorization:`Bearer ${commander.body.token}`},medicHeaders={Authorization:`Bearer ${medic.body.token}`},targetHeaders={Authorization:`Bearer ${target.body.token}`};
  assert.equal((await call('/api/state',{headers:commanderHeaders})).body.participants.length,3);
  assert.equal((await call('/api/messages',{method:'POST',headers:commanderHeaders,body:JSON.stringify({audience:'SERE',body:'Rozkaz dla całej strony'})})).response.status,201);
  assert.equal((await call('/api/state',{headers:targetHeaders})).body.messages[0].body,'Rozkaz dla całej strony');
  await call(`/api/games/${gameId}/settings`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({features:{medicSystem:true},modeSettings:{hitsToRespawn:1,respawnZoneRequired:false}})});
  await call(`/api/games/${gameId}/start`,{method:'POST',headers:adminHeaders,body:'{}'});
  for(const headers of [medicHeaders,targetHeaders])assert.equal((await call('/api/locations',{method:'POST',headers,body:JSON.stringify({latitude:52.2304,longitude:21.0184,accuracy:4,timestamp:new Date().toISOString()})})).response.status,202);
  assert.equal((await call('/api/hits',{method:'POST',headers:targetHeaders,body:'{}'})).body.respawnRequired,true);
  const assisted=await call(`/api/participants/${target.body.participant.id}/assist`,{method:'POST',headers:medicHeaders,body:'{}'});assert.equal(assisted.response.status,200);assert.equal(assisted.body.participant.respawnRequired,false);
  await call('/api/hits',{method:'POST',headers:targetHeaders,body:'{}'});const timer=await call('/api/timers',{method:'POST',headers:targetHeaders,body:'{}'});assert.equal(timer.body.seconds,7);
  const checkpoint={id:crypto.randomUUID(),name:'CP Alfa',type:'CHECKPOINT',team:'SERE',shape:'CIRCLE',center:[52.2304,21.0184],radius:100,color:'#4fd5ff',sequence:1},extraction={id:crypto.randomUUID(),name:'Ewakuacja VIP',type:'EXTRACTION',team:'SERE',shape:'CIRCLE',center:[52.2304,21.0184],radius:100,color:'#d69cff'};
  await call(`/api/games/${gameId}/zones`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({zones:[checkpoint,extraction]})});
  await call(`/api/participants/${commander.body.participant.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'CONVOY'})});await call('/api/locations',{method:'POST',headers:commanderHeaders,body:JSON.stringify({latitude:52.2304,longitude:21.0184,accuracy:4,timestamp:new Date().toISOString()})});
  const checkpointResult=await call(`/api/zones/${checkpoint.id}/interact`,{method:'POST',headers:commanderHeaders,body:'{}'});assert.equal(checkpointResult.body.action,'CHECKPOINT_COMPLETED');assert.equal(checkpointResult.body.zone.completedByTeam,'SERE');
  await call(`/api/participants/${target.body.participant.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'VIP'})});const extractionResult=await call(`/api/zones/${extraction.id}/interact`,{method:'POST',headers:targetHeaders,body:'{}'});assert.equal(extractionResult.body.action,'VIP_EXTRACTED');
  const manual=await call(`/api/games/${gameId}/archives`,{method:'POST',headers:adminHeaders,body:JSON.stringify({label:'Kontrolny zapis operacji'})});assert.equal(manual.response.status,201);
  const archive=await call(`/api/games/${gameId}/archives/${manual.body.id}`,{headers:adminHeaders});assert.equal(archive.body.participants.length,3);assert.equal(archive.body.game.teams.find(team=>team.id===sereSquad.id).respawnSeconds,7);
  await call(`/api/games/${gameId}/finish`,{method:'POST',headers:adminHeaders,body:'{}'});const archives=await call(`/api/games/${gameId}/archives`,{headers:adminHeaders});assert.ok(archives.body.length>=2);assert.ok(archives.body.some(item=>item.automatic));
  assert.equal((await call(`/api/games/${gameId}/archives/${manual.body.id}`,{method:'DELETE',headers:adminHeaders})).response.status,204);
});

test('presety kont, medyk, neutralny sędzia i blokada samodzielnego respawnu działają operacyjnie', async t=>{
  const port=18086,base=`http://127.0.0.1:${port}`,processChild=spawn(process.execPath,['server/index.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),NODE_ENV:'development',ADMIN_PASSWORD:'2468',JWT_SECRET:'advanced-roles-test-secret-at-least-32-characters'},stdio:'ignore'});
  t.after(()=>processChild.kill());await waitForServer(base);
  const call=async(route,options={})=>{const response=await fetch(`${base}${route}`,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const body=response.status===204?null:await response.json();return{response,body};};
  const admin=await call('/api/auth/admin',{method:'POST',body:JSON.stringify({callsign:'GAME-MASTER',password:'2468'})}),gameId=admin.body.gameId,adminHeaders={Authorization:`Bearer ${admin.body.token}`};
  const builtins=await call(`/api/games/${gameId}/staff-presets`,{headers:adminHeaders});assert.ok(builtins.body.length>=5);assert.ok(builtins.body.some(item=>item.id==='REFEREE'));
  const custom=await call(`/api/games/${gameId}/staff-presets`,{method:'POST',headers:adminHeaders,body:JSON.stringify({name:'Pomocnik drużyny',description:'Zakres jednej sekcji.',title:'Pomocnik',team:'SERE',color:'#62a8ff',permissions:['VIEW_TEAM_PLAYERS','SEND_TEAM_MESSAGES']})});assert.equal(custom.response.status,201);assert.equal(custom.body.builtin,false);
  const account=await call('/api/staff',{method:'POST',headers:adminHeaders,body:JSON.stringify({gameId,username:'pomocnik',callsign:'HELPER',password:'Bezpieczne123',title:'Pomocnik',team:'SERE',presetId:custom.body.id,notes:'Zmiana dzienna',expiresAt:new Date(Date.now()+3600000).toISOString(),permissions:custom.body.permissions})});assert.equal(account.body.presetId,custom.body.id);assert.equal(account.body.notes,'Zmiana dzienna');
  const staffLogin=await call('/api/auth/staff',{method:'POST',body:JSON.stringify({code:'WILK24',username:'pomocnik',password:'Bezpieczne123'})});assert.equal(staffLogin.response.status,200);const oldHeaders={Authorization:`Bearer ${staffLogin.body.token}`};assert.equal((await call('/api/state',{headers:oldHeaders})).response.status,200);
  const revoked=await call(`/api/staff/${account.body.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({revokeSessions:true})});assert.equal(revoked.body.sessionVersion,2);assert.equal((await call('/api/state',{headers:oldHeaders})).response.status,401);
  await call('/api/staff',{method:'POST',headers:adminHeaders,body:JSON.stringify({gameId,username:'wygasly',callsign:'EXPIRED',password:'Bezpieczne123',title:'Obserwator',team:'ALL',expiresAt:new Date(Date.now()-60000).toISOString(),permissions:['VIEW_EVENTS']})});assert.equal((await call('/api/auth/staff',{method:'POST',body:JSON.stringify({code:'WILK24',username:'wygasly',password:'Bezpieczne123'})})).response.status,401);
  const join=async(callsign,team='SERE')=>call('/api/games/WILK24/join',{method:'POST',body:JSON.stringify({callsign,team,consent:true,consentVersion:'test'})});
  const referee=await join('REF-1'),medic=await join('MED-1'),target=await join('WOUNDED-1');const refHeaders={Authorization:`Bearer ${referee.body.token}`},medicHeaders={Authorization:`Bearer ${medic.body.token}`},targetHeaders={Authorization:`Bearer ${target.body.token}`};
  const assignedRef=await call(`/api/participants/${referee.body.participant.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'REFEREE'})});assert.equal(assignedRef.body.team,'NEUTRAL');assert.equal(assignedRef.body.squadId,null);assert.ok(assignedRef.body.capabilities.includes('INVULNERABLE'));
  await call(`/api/participants/${medic.body.participant.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'MEDIC'})});
  await call(`/api/games/${gameId}/settings`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({features:{medicSystem:true,selfRespawn:false,fieldRefereeControls:true},modeSettings:{hitsToRespawn:2,respawnZoneRequired:false}})});await call(`/api/games/${gameId}/start`,{method:'POST',headers:adminHeaders,body:'{}'});
  for(const headers of [refHeaders,medicHeaders,targetHeaders])assert.equal((await call('/api/locations',{method:'POST',headers,body:JSON.stringify({latitude:52.2304,longitude:21.0184,accuracy:3,timestamp:new Date().toISOString()})})).response.status,202);
  const protectedHit=await call('/api/hits',{method:'POST',headers:refHeaders,body:'{}'});assert.equal(protectedHit.body.protected,true);assert.equal(protectedHit.body.participant.hitCount,0);
  const wounded=await call('/api/hits',{method:'POST',headers:targetHeaders,body:'{}'});assert.equal(wounded.body.participant.healthState,'WOUNDED');const healed=await call(`/api/participants/${target.body.participant.id}/assist`,{method:'POST',headers:medicHeaders,body:'{}'});assert.equal(healed.body.participant.healthState,'HEALTHY');
  await call('/api/hits',{method:'POST',headers:targetHeaders,body:'{}'});await call('/api/hits',{method:'POST',headers:targetHeaders,body:'{}'});const blockedTimer=await call('/api/timers',{method:'POST',headers:targetHeaders,body:'{}'});assert.equal(blockedTimer.response.status,409);assert.match(blockedTimer.body.error,/medyka lub sędziego/i);
  const visible=await call('/api/participants/field-control',{method:'POST',headers:refHeaders,body:JSON.stringify({action:'VISIBILITY'})});assert.equal(visible.body.participant.fieldVisible,true);assert.ok((await call('/api/state',{headers:targetHeaders})).body.participants.some(item=>item.id===referee.body.participant.id));
  const paused=await call('/api/participants/field-control',{method:'POST',headers:refHeaders,body:JSON.stringify({action:'PAUSE'})});assert.equal(paused.body.game.state,'PAUSED');const resumed=await call('/api/participants/field-control',{method:'POST',headers:refHeaders,body:JSON.stringify({action:'RESUME'})});assert.equal(resumed.body.game.state,'ACTIVE');const signal=await call('/api/participants/field-control',{method:'POST',headers:refHeaders,body:JSON.stringify({action:'SIGNAL',signal:'FREEZE'})});assert.equal(signal.response.status,201);assert.equal(signal.body.message.signalType,'FREEZE');
  const disabled=await call(`/api/participants/${referee.body.participant.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({disabledCapabilities:['PAUSE_GAME']})});assert.ok(!disabled.body.capabilities.includes('PAUSE_GAME'));assert.equal((await call('/api/participants/field-control',{method:'POST',headers:refHeaders,body:JSON.stringify({action:'PAUSE'})})).response.status,403);
  assert.equal((await call(`/api/games/${gameId}/staff-presets/${custom.body.id}`,{method:'DELETE',headers:adminHeaders})).response.status,204);
});
