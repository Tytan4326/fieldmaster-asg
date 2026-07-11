import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.ADMIN_PASSWORD)) {
  throw new Error('JWT_SECRET i ADMIN_PASSWORD są wymagane w środowisku produkcyjnym.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-secret-change-before-deploy';
const ADMIN_CALLSIGN = process.env.ADMIN_CALLSIGN || 'GAME-MASTER';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2468';
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 250_000 });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use('/api/auth', rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
app.use(express.static(path.join(__dirname, '..', 'public')));

const boundary = [
  [52.2280, 21.0060], [52.2357, 21.0092], [52.2380, 21.0220],
  [52.2332, 21.0310], [52.2248, 21.0250], [52.2228, 21.0140]
];

// Store demonstracyjny. Interfejs repozytorium jest celowo mały, aby podmienić go
// na transakcje PostgreSQL zgodnie z server/schema.sql bez zmiany kontrolerów.
const store = {
  games: new Map(), participants: new Map(), events: [], timers: new Map(), sos: new Map()
};
let persistenceTimer;
function persistSoon() {
  if (!DATA_FILE) return;
  clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(() => {
    const payload = {
      games: [...store.games.values()], participants: [...store.participants.values()],
      events: store.events.slice(0, 10_000), timers: [...store.timers.values()], sos: [...store.sos.values()]
    };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const temporary = `${DATA_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
    fs.renameSync(temporary, DATA_FILE);
  }, 250);
}
function restoreState() {
  if (!DATA_FILE || !fs.existsSync(DATA_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const item of data.games || []) store.games.set(item.id, item);
    for (const item of data.participants || []) {
      item.activeTimer = null;
      if (['TIMER','RESPAWN'].includes(item.status)) item.status = 'ACTIVE';
      store.participants.set(item.id, item);
    }
    for (const item of data.timers || []) store.timers.set(item.id, { ...item, cancelledAt: item.cancelledAt || Date.now() });
    for (const item of data.sos || []) store.sos.set(item.id, item);
    store.events = data.events || [];
    return store.games.size > 0;
  } catch (error) {
    console.error('Nie udało się odczytać stanu lokalnego:', error.message);
    return false;
  }
}
const restored = restoreState();
let demoGame = [...store.games.values()].find(game => game.code === 'WILK24');
if (!restored || !demoGame) {
  demoGame = {
    id: crypto.randomUUID(), code: 'WILK24', name: 'Operacja Nocny Wilk', state: 'LOBBY',
    durationMinutes: 1440, sereTimerSeconds: 20, opforTimerSeconds: 60, boundary,
    startedAt: null, finishedAt: null, createdAt: new Date().toISOString()
  };
  store.games.set(demoGame.id, demoGame);
  persistSoon();
}

const joinSchema = z.object({
  callsign: z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N}_ -]+$/u),
  team: z.enum(['SERE', 'OPFOR']),
  consent: z.literal(true),
  consentVersion: z.string().default('2026-07-11')
});
const locationSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(10_000).optional(), battery: z.number().min(0).max(100).optional(),
  timestamp: z.string().datetime().optional()
});
const settingsSchema = z.object({
  name: z.string().trim().min(3).max(100).optional(),
  durationMinutes: z.number().int().min(10).max(2880).optional(),
  sereTimerSeconds: z.number().int().min(5).max(600).optional(),
  opforTimerSeconds: z.number().int().min(5).max(600).optional(),
  boundary: z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).min(3).max(100).optional()
}).refine(value => Object.keys(value).length > 0);
const participantUpdateSchema = z.object({
  status: z.enum(['WAITING','READY','ACTIVE','TIMER','RESPAWN','CAPTURED','OUTSIDE','SOS','DISCONNECTED','FINISHED','REMOVED']).optional(),
  team: z.enum(['SERE','OPFOR']).optional()
}).refine(value => Object.keys(value).length > 0);

function sign(payload, expiresIn = '12h') { return jwt.sign(payload, JWT_SECRET, { expiresIn }); }
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    req.auth = jwt.verify(token, JWT_SECRET); next();
  } catch { res.status(401).json({ error: 'Brak ważnej sesji.' }); }
}
function requireRole(...roles) { return (req, res, next) => roles.includes(req.auth?.role) ? next() : res.status(403).json({ error: 'Brak uprawnienia.' }); }
function event(gameId, type, details = {}, participantId = null, severity = 'INFO') {
  const item = { id: crypto.randomUUID(), gameId, participantId, type, severity, details, createdAt: new Date().toISOString() };
  store.events.unshift(item); io.to(`game:${gameId}:staff`).emit('event:new', item); persistSoon(); return item;
}
function participantView(p) {
  const { token, ...safe } = p;
  const timer = p.activeTimer ? store.timers.get(p.activeTimer) : null;
  return { ...safe, timerEnd: timer?.endsAt || null };
}
function visibleParticipants(gameId, viewer) {
  return [...store.participants.values()].filter(p => p.gameId === gameId).filter(p => {
    if (['ADMIN', 'MODERATOR'].includes(viewer.role)) return true;
    if (p.activeSos) return true;
    if (p.id === viewer.participantId) return true;
    return viewer.team === 'OPFOR' && p.team === 'OPFOR';
  }).map(participantView);
}
function gameByCode(code) { return [...store.games.values()].find(g => g.code === code.toUpperCase()); }
function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}
function activeSos(gameId) {
  return [...store.sos.values()].filter(s => s.gameId === gameId && ['ACTIVE','ACKNOWLEDGED'].includes(s.status));
}
function snapshot(gameId, viewer) {
  return {
    game: store.games.get(gameId),
    participants: visibleParticipants(gameId, viewer),
    sos: activeSos(gameId),
    events: ['ADMIN','MODERATOR'].includes(viewer.role) ? store.events.filter(e => e.gameId === gameId).slice(0, 200) : []
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, now: new Date().toISOString(), sockets: io.engine.clientsCount }));
app.get('/api/games/:code/public', (req, res) => {
  const game = gameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Nie znaleziono sesji.' });
  res.json({ id: game.id, code: game.code, name: game.name, state: game.state, participantCount: [...store.participants.values()].filter(p => p.gameId === game.id).length });
});
app.post('/api/auth/admin', async (req, res) => {
  const callsignOk = String(req.body?.callsign || '').toUpperCase() === ADMIN_CALLSIGN.toUpperCase();
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 8);
  const passwordOk = await bcrypt.compare(String(req.body?.password || ''), passwordHash);
  if (!callsignOk || !passwordOk) return res.status(401).json({ error: 'Nieprawidłowe dane.' });
  res.json({ token: sign({ role: 'ADMIN', callsign: ADMIN_CALLSIGN, gameId: demoGame.id }), role: 'ADMIN', gameId: demoGame.id });
});
app.post('/api/games/:code/join', (req, res) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Sprawdź kryptonim, drużynę i zgody.', issues: parsed.error.issues });
  const game = gameByCode(req.params.code);
  if (!game || !['LOBBY', 'DRAFT'].includes(game.state)) return res.status(409).json({ error: 'Do tej sesji nie można teraz dołączyć.' });
  const normalized = parsed.data.callsign.toLocaleUpperCase('pl-PL');
  const duplicate = [...store.participants.values()].some(p => p.gameId === game.id && p.normalizedCallsign === normalized);
  if (duplicate) return res.status(409).json({ error: 'Ten kryptonim jest już zajęty.' });
  const participant = {
    id: crypto.randomUUID(), gameId: game.id, callsign: parsed.data.callsign, normalizedCallsign: normalized,
    team: parsed.data.team, status: 'READY', consentVersion: parsed.data.consentVersion,
    consentedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), location: null,
    timerCount: 0, boundaryCount: 0, activeSos: false
  };
  store.participants.set(participant.id, participant);
  event(game.id, 'PARTICIPANT_JOINED', { callsign: participant.callsign, team: participant.team }, participant.id);
  broadcastState(game.id);
  res.status(201).json({ participant: participantView(participant), game, token: sign({ role: 'PARTICIPANT', team: participant.team, gameId: game.id, participantId: participant.id }) });
});

app.get('/api/state', auth, (req, res) => {
  const gameId = req.auth.gameId || req.query.gameId || demoGame.id;
  const game = store.games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Nie znaleziono sesji.' });
  res.json(snapshot(gameId, req.auth));
});
app.patch('/api/games/:id/settings', auth, requireRole('ADMIN'), (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  const game = store.games.get(req.params.id);
  if (!parsed.success || !game) return res.status(400).json({ error: 'Nieprawidłowe ustawienia gry.' });
  if (game.state === 'ACTIVE' && parsed.data.boundary) return res.status(409).json({ error: 'Wstrzymaj grę przed zmianą granicy terenu.' });
  Object.assign(game, parsed.data);
  event(game.id, 'GAME_SETTINGS_CHANGED', { fields: Object.keys(parsed.data) });
  broadcastState(game.id);
  io.to(`game:${game.id}`).emit('game:changed', game);
  res.json(game);
});
app.patch('/api/participants/:id', auth, requireRole('ADMIN','MODERATOR'), (req, res) => {
  const parsed = participantUpdateSchema.safeParse(req.body);
  const participant = store.participants.get(req.params.id);
  const game = participant && store.games.get(participant.gameId);
  if (!parsed.success || !participant || !game) return res.status(400).json({ error: 'Nieprawidłowa zmiana uczestnika.' });
  if (parsed.data.team && game.state !== 'LOBBY') return res.status(409).json({ error: 'Drużynę można zmienić tylko przed startem gry.' });
  Object.assign(participant, parsed.data);
  event(game.id, 'PARTICIPANT_CHANGED', { callsign: participant.callsign, ...parsed.data }, participant.id);
  broadcastState(game.id);
  res.json(participantView(participant));
});
app.post('/api/locations', auth, requireRole('PARTICIPANT'), (req, res) => {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nieprawidłowa lokalizacja.' });
  const p = store.participants.get(req.auth.participantId); const game = store.games.get(p?.gameId);
  if (!p || !game || game.state !== 'ACTIVE') return res.status(409).json({ error: 'Śledzenie działa tylko w aktywnej grze.' });
  const loc = { ...parsed.data, timestamp: parsed.data.timestamp || new Date().toISOString() };
  p.location = loc; p.lastSeenAt = new Date().toISOString(); p.battery = loc.battery ?? p.battery;
  const outside = !pointInPolygon(loc.latitude, loc.longitude, game.boundary);
  if (outside !== Boolean(p.outside)) {
    p.outside = outside; p.status = outside ? 'OUTSIDE' : 'ACTIVE';
    if (outside) p.boundaryCount += 1;
    event(game.id, outside ? 'BOUNDARY_EXIT' : 'BOUNDARY_RETURN', { callsign: p.callsign }, p.id, outside ? 'WARNING' : 'INFO');
  }
  broadcastState(game.id); res.status(202).json({ accepted: true, outside });
});
app.post('/api/timers', auth, requireRole('PARTICIPANT'), (req, res) => {
  const p = store.participants.get(req.auth.participantId); const game = store.games.get(p?.gameId);
  if (!p || !game || game.state !== 'ACTIVE' || p.activeTimer) return res.status(409).json({ error: 'Timer nie może być teraz uruchomiony.' });
  const seconds = p.team === 'SERE' ? game.sereTimerSeconds : game.opforTimerSeconds;
  const timer = { id: crypto.randomUUID(), gameId: game.id, participantId: p.id, seconds, startedAt: Date.now(), endsAt: Date.now() + seconds * 1000 };
  store.timers.set(timer.id, timer); p.activeTimer = timer.id; p.timerCount += 1; p.status = p.team === 'SERE' ? 'TIMER' : 'RESPAWN';
  event(game.id, 'TIMER_STARTED', { callsign: p.callsign, seconds }, p.id); broadcastState(game.id);
  setTimeout(() => { const current = store.timers.get(timer.id); if (!current || current.completedAt) return; current.completedAt = Date.now(); p.activeTimer = null; p.status = 'ACTIVE'; event(game.id, 'TIMER_FINISHED', { callsign: p.callsign }, p.id); broadcastState(game.id); }, seconds * 1000);
  res.status(201).json(timer);
});
app.post('/api/sos', auth, requireRole('PARTICIPANT'), (req, res) => {
  const p = store.participants.get(req.auth.participantId); const game = store.games.get(p?.gameId);
  if (!p || !game || game.state === 'FINISHED') return res.status(409).json({ error: 'SOS nie może być zapisany w tej sesji.' });
  const alert = { id: crypto.randomUUID(), gameId: game.id, participantId: p.id, callsign: p.callsign, team: p.team, status: 'ACTIVE', location: p.location, activatedAt: new Date().toISOString() };
  store.sos.set(alert.id, alert); p.activeSos = true; p.status = 'SOS';
  event(game.id, 'SOS_ACTIVATED', { callsign: p.callsign, location: p.location }, p.id, 'CRITICAL');
  io.to(`game:${game.id}`).emit('sos:changed', alert); broadcastState(game.id); res.status(201).json(alert);
});
app.patch('/api/sos/:id', auth, requireRole('ADMIN','MODERATOR'), (req, res) => {
  const status = z.enum(['ACKNOWLEDGED','RESOLVED','FALSE_ALARM']).safeParse(req.body?.status);
  const alert = store.sos.get(req.params.id);
  if (!status.success || !alert) return res.status(400).json({ error: 'Nieprawidłowy alarm lub status.' });
  alert.status = status.data; alert.updatedAt = new Date().toISOString();
  const p = store.participants.get(alert.participantId);
  if (status.data !== 'ACKNOWLEDGED' && p) { p.activeSos = false; p.status = 'ACTIVE'; }
  event(alert.gameId, `SOS_${status.data}`, { callsign: alert.callsign }, alert.participantId, status.data === 'ACKNOWLEDGED' ? 'WARNING' : 'INFO');
  io.to(`game:${alert.gameId}`).emit('sos:changed', alert); broadcastState(alert.gameId); res.json(alert);
});
app.post('/api/messages', auth, requireRole('ADMIN'), (req, res) => {
  const parsed = z.object({ audience: z.enum(['ALL','SERE','OPFOR']), body: z.string().trim().min(1).max(300) }).safeParse(req.body);
  const gameId = req.auth.gameId || demoGame.id;
  if (!parsed.success || !store.games.has(gameId)) return res.status(400).json({ error: 'Nieprawidłowy komunikat.' });
  const message = { id: crypto.randomUUID(), gameId, ...parsed.data, time: Date.now(), createdAt: new Date().toISOString() };
  event(gameId, 'ADMIN_MESSAGE', { audience: message.audience, body: message.body });
  io.to(`game:${gameId}`).emit('message:new', message);
  res.status(201).json(message);
});
app.post('/api/games/:id/:action(start|pause|resume|finish)', auth, requireRole('ADMIN'), (req, res) => {
  const game = store.games.get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Nie znaleziono gry.' });
  const next = { start: 'ACTIVE', pause: 'PAUSED', resume: 'ACTIVE', finish: 'FINISHED' }[req.params.action];
  game.state = next; game[`${req.params.action === 'finish' ? 'finished' : req.params.action === 'start' ? 'started' : req.params.action}At`] = new Date().toISOString();
  if (req.params.action === 'start' || req.params.action === 'resume') {
    for (const p of store.participants.values()) if (p.gameId === game.id && !p.activeSos) p.status = 'ACTIVE';
  }
  if (req.params.action === 'finish') {
    for (const p of store.participants.values()) if (p.gameId === game.id) p.status = 'FINISHED';
  }
  event(game.id, `GAME_${next}`, {}, null, next === 'FINISHED' ? 'WARNING' : 'INFO');
  io.to(`game:${game.id}`).emit('game:changed', game); broadcastState(game.id); res.json(game);
});

function broadcastState(gameId) {
  persistSoon();
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.gameId === gameId) socket.emit('state:snapshot', snapshot(gameId, socket.auth));
  }
}

io.use((socket, next) => { try { socket.auth = jwt.verify(socket.handshake.auth?.token, JWT_SECRET); next(); } catch { next(new Error('unauthorized')); } });
io.on('connection', socket => {
  const a = socket.auth; const gameId = a.gameId || socket.handshake.auth?.gameId || demoGame.id;
  socket.data.gameId = gameId;
  socket.join(`game:${gameId}`);
  if (['ADMIN','MODERATOR'].includes(a.role)) socket.join(`game:${gameId}:staff`);
  if (a.team) socket.join(`game:${gameId}:team:${a.team}`);
  socket.emit('state:snapshot', snapshot(gameId, a));
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
server.listen(PORT, () => console.log(`Fieldmaster listening on http://localhost:${PORT}`));
