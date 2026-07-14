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

const DEFAULT_FEATURES = Object.freeze({
  gpsTracking: true, geofence: true, sos: true, timers: true,
  allowTeamChanges: true, allowJoining: true, satelliteDefault: true, mgrsGrid: true,
  shareLocationInLobby: true, opforTeamMap: true, audioAlarms: true, vibration: true,
  boundaryReminders: true, pwaInstall: true, adminMessages: true, csvExport: true,
  showBattery: true, showAccuracy: true, gpsFallback: true, offlineQueue: true,
  playerMessaging: true, hitTracking: true, respawnZones: true, fovPrediction: true,
  compassSharing: true, objectives: true, commanderApp: true, scoreBoard: true,
  backgroundTrackingAid: true, screenWakeLock: true, pushNotifications: true,
  reconnectRecovery: true, stableMapRendering: true, gpsQualityWarnings: true,
  hardwareTimerShortcut: false, automaticCheckpoints: false, stealthMode: false,
  fogOfWar: false, medicSystem: false, ammoLogistics: false,
  mgrsAdmin: true, mgrsStaff: true, mgrsPlayer: true,
  routeReplay: true, modeIntel: true, zoneInteractions: true, stateAwareMarkers: true,
  messageNotifications: true, sosBroadcastAlarms: true,
  teamOperations: true, roleAbilities: true, commanderBroadcast: true,
  autoSessionArchive: true
});
const FEATURE_KEYS = Object.keys(DEFAULT_FEATURES);
const STAFF_PERMISSIONS = Object.freeze([
  'VIEW_ALL_PLAYERS','VIEW_TEAM_PLAYERS','VIEW_FOV','VIEW_EVENTS','VIEW_SOS',
  'VIEW_PLAYER_STATUS','VIEW_COORDINATES','VIEW_BATTERY','VIEW_ACCURACY','VIEW_TRACKS','VIEW_REPLAY','VIEW_MODE_INTEL',
  'SEND_ALL_MESSAGES','SEND_TEAM_MESSAGES','SEND_DIRECT_MESSAGES','RECEIVE_PLAYER_MESSAGES',
  'MANAGE_PARTICIPANTS','MANAGE_TEAMS','MANAGE_ZONES','MANAGE_RESPAWNS','MANAGE_OBJECTIVES','MANAGE_FLAGS',
  'MANAGE_CHECKPOINTS','MANAGE_MODE_RULES','MANAGE_GAME_STATE','MANAGE_MESSAGES','ACK_SOS','TRIGGER_NOTIFICATIONS',
  'VIEW_REPORTS','EXPORT_REPORTS'
]);
const commonMode = (overrides, modeRules) => ({
  hitsToRespawn: 1, respawnSeconds: 60, respawnZoneRequired: true, lives: 0,
  scoreLimit: 0, roundMinutes: 120, fovRange: 150, fovAngle: 65,
  ...overrides, modeRules
});
const GAME_MODES = Object.freeze({
  CLASSIC_SERE: { name: 'SERE / Polowanie', description: 'Jedna strona ukrywa się, druga prowadzi pościg.', defaults: commonMode({ respawnZoneRequired: false, lives: 1, roundMinutes: 240, fovRange: 180, fovAngle: 70 }, { captureSeconds: 90, seekerDelayMinutes: 20, revealIntervalMinutes: 30 }) },
  DOMINATION: { name: 'Dominacja', description: 'Zespoły przejmują i utrzymują strefy punktowe.', defaults: commonMode({ hitsToRespawn: 2, respawnSeconds: 45, scoreLimit: 500 }, { captureSeconds: 45, pointsPerMinute: 10, zonesToWin: 3 }) },
  CAPTURE_FLAG: { name: 'Capture the Flag', description: 'Przechwycenie flagi przeciwnika i powrót do bazy.', defaults: commonMode({ respawnSeconds: 40, scoreLimit: 5, roundMinutes: 90 }, { flagReturnSeconds: 120, capturesToWin: 3, carrierVisible: true }) },
  VIP_ESCORT: { name: 'Eskorta VIP', description: 'Eskorta chroni VIP-a w drodze do strefy ewakuacji.', defaults: commonMode({ hitsToRespawn: 2, lives: 3, scoreLimit: 1, roundMinutes: 90, fovRange: 160, fovAngle: 70 }, { extractionHoldSeconds: 60, vipLives: 1, vipVisible: false }) },
  SEARCH_RESCUE: { name: 'Search & Rescue', description: 'Poszukiwanie celów i ewakuacja do bezpiecznej strefy.', defaults: commonMode({ hitsToRespawn: 3, respawnSeconds: 90, lives: 2, scoreLimit: 4, roundMinutes: 180, fovRange: 200, fovAngle: 80 }, { objectivesToFind: 4, extractionHoldSeconds: 90, intelRevealMinutes: 20 }) },
  TEAM_DEATHMATCH: { name: 'Team Deathmatch', description: 'Punktowana walka drużynowa z falami respawnu.', defaults: commonMode({ respawnSeconds: 30, scoreLimit: 100, roundMinutes: 60, fovRange: 130, fovAngle: 60 }, { pointsPerHit: 1, waveRespawnSeconds: 60, friendlyFire: false }) },
  BOMB_DEFUSAL: { name: 'Podłożenie ładunku', description: 'Atakujący podkładają ładunek, obrońcy próbują go rozbroić.', defaults: commonMode({ lives: 1, scoreLimit: 7, roundMinutes: 45 }, { plantSeconds: 15, defuseSeconds: 20, bombTimerSeconds: 300, roundsToWin: 4 }) },
  KING_HILL: { name: 'Król wzgórza', description: 'Utrzymanie ruchomej strefy daje punkty drużynie.', defaults: commonMode({ hitsToRespawn: 2, respawnSeconds: 45, scoreLimit: 600, roundMinutes: 100 }, { captureSeconds: 30, pointsPerMinute: 20, hillMoveMinutes: 15 }) },
  CONVOY_AMBUSH: { name: 'Konwój / Zasadzka', description: 'Eskorta prowadzi konwój przez kolejne punkty kontrolne.', defaults: commonMode({ lives: 3, scoreLimit: 5, roundMinutes: 150 }, { convoyLives: 3, ambushDelayMinutes: 10 }) },
  INFECTION: { name: 'Infekcja', description: 'Trafieni przechodzą do rosnącej drużyny zainfekowanych.', defaults: commonMode({ respawnSeconds: 15, roundMinutes: 90 }, { initialInfected: 2, conversionSeconds: 30, survivorWinMinutes: 60 }) },
  MEDIC_RESCUE: { name: 'Medyk / Ratunek', description: 'Drużyny stabilizują rannych i ewakuują ich do punktu medycznego.', defaults: commonMode({ hitsToRespawn: 2, respawnSeconds: 120, lives: 2, roundMinutes: 180 }, { bleedoutSeconds: 300, reviveSeconds: 60, medicLives: 3 }) },
  SUPPLY_DROP: { name: 'Zrzut zaopatrzenia', description: 'Zespoły odnajdują, przenoszą i zabezpieczają skrzynie.', defaults: commonMode({ scoreLimit: 5, roundMinutes: 120 }, { cratesToWin: 5, dropRevealMinutes: 10, carryLimit: 1 }) }
});
const DEFAULT_MODE = 'CLASSIC_SERE';
const defaultModeSettings = mode => structuredClone(GAME_MODES[mode || DEFAULT_MODE].defaults);
const ROLE_CAPABILITIES = Object.freeze([
  'TEAM_MAP','COMMAND','REVIVE','BOMB_SPECIALIST','RECON','EXTRACTION_TARGET',
  'CHECKPOINT_OPERATOR','RESPAWN_MANAGER','OBJECTIVE_OPERATOR','SAFETY_OVERRIDE'
]);
const BUILTIN_ROLES = Object.freeze([
  { code:'OPERATOR', name:'Operator', icon:'OP', color:'#dce5e8', description:'Podstawowa rola liniowa bez specjalnych uprawnień.', capabilities:[], active:true },
  { code:'COMMANDER', name:'Dowódca', icon:'DC', color:'#ffc247', description:'Widzi stronę na mapie i może nadawać komunikaty do swojej strony.', capabilities:['TEAM_MAP','COMMAND'], active:true },
  { code:'MEDIC', name:'Medyk', icon:'MD', color:'#43e58d', description:'Może przywrócić pobliskiego członka swojej strony do walki.', capabilities:['REVIVE'], active:true },
  { code:'ENGINEER', name:'Saper', icon:'SP', color:'#ff8b45', description:'Podkłada i rozbraja ładunki o 35% szybciej.', capabilities:['BOMB_SPECIALIST','OBJECTIVE_OPERATOR'], active:true },
  { code:'VIP', name:'VIP', icon:'VIP', color:'#d69cff', description:'Kluczowy cel eskorty i ewakuacji.', capabilities:['EXTRACTION_TARGET'], active:true },
  { code:'CONVOY', name:'Operator konwoju', icon:'CV', color:'#62a8ff', description:'Obsługuje trasę i checkpointy konwoju.', capabilities:['CHECKPOINT_OPERATOR'], active:true },
  { code:'SCOUT', name:'Zwiadowca', icon:'ZW', color:'#5ee7d4', description:'Rola rozpoznawcza z widocznością własnego zespołu.', capabilities:['RECON'], active:true },
  { code:'REFEREE', name:'Sędzia polowy', icon:'RF', color:'#ff5d5d', description:'Nadzoruje bezpieczeństwo i może zarządzać respawnem.', capabilities:['RESPAWN_MANAGER','SAFETY_OVERRIDE'], active:true }
]);
const defaultRoles = () => structuredClone(BUILTIN_ROLES);
const defaultTeams = () => [
  { id:crypto.randomUUID(), code:'SERE-ALFA', name:'SERE Alfa', side:'SERE', color:'#a3ff4f', mapSharing:'SQUAD', respawnSeconds:null, maxPlayers:100, radioChannel:'SERE-1', active:true, allowedRoles:BUILTIN_ROLES.map(role=>role.code) },
  { id:crypto.randomUUID(), code:'OPFOR-BRAWO', name:'OPFOR Brawo', side:'OPFOR', color:'#ff8a45', mapSharing:'SQUAD', respawnSeconds:null, maxPlayers:100, radioChannel:'OPFOR-1', active:true, allowedRoles:BUILTIN_ROLES.map(role=>role.code) }
];
const SESSION_PRESETS = Object.freeze({
  SERE_HUNT:{ name:'SERE — długie polowanie', icon:'SR', description:'Skryta rozgrywka, pojedyncze życie i ograniczona widoczność.', mode:'CLASSIC_SERE', durationMinutes:240, sereTimerSeconds:20, opforTimerSeconds:60, features:{ fogOfWar:true, stealthMode:true, opforTeamMap:true, medicSystem:false }, modeSettings:{ lives:1, respawnZoneRequired:false } },
  BOMB_TACTICAL:{ name:'Ładunek — taktyczny', icon:'BD', description:'Szybkie rundy, saperzy i interaktywne strefy ładunków.', mode:'BOMB_DEFUSAL', durationMinutes:60, sereTimerSeconds:15, opforTimerSeconds:15, features:{ roleAbilities:true, zoneInteractions:true, objectives:true }, modeSettings:{ lives:1, respawnSeconds:45, modeRules:{ plantSeconds:15, defuseSeconds:20, bombTimerSeconds:240, roundsToWin:4 } } },
  DOMINATION_FAST:{ name:'Dominacja — dynamiczna', icon:'DM', description:'Trzy strefy, szybki respawn i wynik na żywo.', mode:'DOMINATION', durationMinutes:90, sereTimerSeconds:15, opforTimerSeconds:15, features:{ scoreBoard:true, modeIntel:true, automaticCheckpoints:true }, modeSettings:{ respawnSeconds:30, scoreLimit:500, modeRules:{ captureSeconds:30, pointsPerMinute:15, zonesToWin:3 } } },
  CONVOY_COMMAND:{ name:'Konwój — dowodzenie', icon:'CV', description:'Widoczność zespołów, checkpointy i łączność dowódcza.', mode:'CONVOY_AMBUSH', durationMinutes:150, sereTimerSeconds:30, opforTimerSeconds:30, features:{ commanderBroadcast:true, automaticCheckpoints:true, teamOperations:true }, modeSettings:{ lives:3, modeRules:{ convoyLives:3, ambushDelayMinutes:10 } } },
  MEDICAL_MISSION:{ name:'Misja medyczna', icon:'MD', description:'Rozbudowany respawn, medycy i ewakuacja rannych.', mode:'MEDIC_RESCUE', durationMinutes:180, sereTimerSeconds:25, opforTimerSeconds:25, features:{ medicSystem:true, roleAbilities:true, respawnZones:true }, modeSettings:{ hitsToRespawn:2, respawnSeconds:120, modeRules:{ bleedoutSeconds:300, reviveSeconds:45, medicLives:3 } } },
  MILSIM_COMMAND:{ name:'MILSIM — pełne dowodzenie', icon:'C2', description:'Role, drużyny, MGRS, replay, archiwizacja i rozbudowana telemetria.', mode:'SEARCH_RESCUE', durationMinutes:360, sereTimerSeconds:30, opforTimerSeconds:45, features:{ teamOperations:true, roleAbilities:true, commanderBroadcast:true, mgrsGrid:true, routeReplay:true, autoSessionArchive:true, stateAwareMarkers:true, fovPrediction:true, compassSharing:true }, modeSettings:{ lives:2, respawnSeconds:120, fovRange:220, fovAngle:75 } }
});

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
  games: new Map(), participants: new Map(), staff: new Map(), events: [], messages: [], tracks: [], timers: new Map(), sos: new Map(), archives: []
};
const timerTimeouts = new Map();
const zoneTimeouts = new Map();
const bombTimeouts = new Map();
let persistenceTimer;
function persistSoon() {
  if (!DATA_FILE) return;
  clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(() => {
    const payload = {
      games: [...store.games.values()], participants: [...store.participants.values()], staff: [...store.staff.values()],
      events: store.events.slice(0, 10_000), messages: store.messages.slice(0, 10_000), tracks: store.tracks.slice(-100_000), timers: [...store.timers.values()], sos: [...store.sos.values()], archives: store.archives.slice(0, 500)
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
    for (const item of data.games || []) {
      const mode = GAME_MODES[item.mode] ? item.mode : DEFAULT_MODE;
      const restoredSettings = { ...defaultModeSettings(mode), ...(item.modeSettings || {}) };
      restoredSettings.modeRules = { ...defaultModeSettings(mode).modeRules, ...(item.modeSettings?.modeRules || {}) };
      store.games.set(item.id, { ...item, mode, modeSettings: restoredSettings, zones: item.zones || [], objectives: item.objectives || [], teams: item.teams?.length ? item.teams : defaultTeams(), roles: item.roles?.length ? item.roles : defaultRoles(), scores: { SERE: 0, OPFOR: 0, ...(item.scores || {}) }, features: { ...DEFAULT_FEATURES, ...(item.features || {}) } });
    }
    for (const item of data.participants || []) {
      item.activeTimer = null;
      if (['TIMER','RESPAWN'].includes(item.status)) item.status = 'ACTIVE';
      store.participants.set(item.id, item);
    }
    for (const item of data.staff || []) store.staff.set(item.id, item);
    for (const item of data.timers || []) store.timers.set(item.id, { ...item, cancelledAt: item.cancelledAt || Date.now() });
    for (const item of data.sos || []) store.sos.set(item.id, item);
    store.events = data.events || []; store.messages = data.messages || []; store.tracks = data.tracks || []; store.archives = data.archives || [];
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
    mode: DEFAULT_MODE, modeSettings: defaultModeSettings(DEFAULT_MODE), zones: [], objectives: [], teams: defaultTeams(), roles: defaultRoles(), scores: { SERE: 0, OPFOR: 0 }, features: { ...DEFAULT_FEATURES },
    startedAt: null, finishedAt: null, createdAt: new Date().toISOString()
  };
  store.games.set(demoGame.id, demoGame);
  persistSoon();
}
demoGame ||= [...store.games.values()][0];

function makeGame({ code, name, source = demoGame }) {
  return {
    id: crypto.randomUUID(), code, name, state: 'LOBBY',
    durationMinutes: source?.durationMinutes || 1440,
    sereTimerSeconds: source?.sereTimerSeconds || 20,
    opforTimerSeconds: source?.opforTimerSeconds || 60,
    boundary: (source?.boundary || boundary).map(point => [...point]),
    mode: source?.mode || DEFAULT_MODE,
    modeSettings: { ...defaultModeSettings(source?.mode || DEFAULT_MODE), ...(source?.modeSettings || {}), modeRules: { ...defaultModeSettings(source?.mode || DEFAULT_MODE).modeRules, ...(source?.modeSettings?.modeRules || {}) } },
    zones: (source?.zones || []).map(zone => ({ ...zone, center: [...zone.center], points: zone.points?.map(point => [...point]) })),
    objectives: (source?.objectives || []).map(objective => ({ ...objective })),
    teams: (source?.teams?.length ? source.teams : defaultTeams()).map(team => ({ ...team, id:crypto.randomUUID(), allowedRoles:[...(team.allowedRoles || [])] })),
    roles: (source?.roles?.length ? source.roles : defaultRoles()).map(role => ({ ...role, capabilities:[...(role.capabilities || [])] })),
    scores: { SERE: 0, OPFOR: 0 },
    features: { ...DEFAULT_FEATURES, ...(source?.features || {}) },
    startedAt: null, pausedAt: null, finishedAt: null, createdAt: new Date().toISOString()
  };
}

const joinSchema = z.object({
  callsign: z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N}_ -]+$/u),
  team: z.enum(['SERE', 'OPFOR']),
  squadId: z.string().uuid().nullable().optional(),
  consent: z.literal(true),
  consentVersion: z.string().default('2026-07-11')
});
const locationSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(10_000).optional(), battery: z.number().min(0).max(100).optional(),
  heading: z.number().min(0).max(360).nullable().optional(), speed: z.number().min(0).max(150).nullable().optional(), headingSource: z.enum(['GPS','COMPASS','MOVEMENT','MANUAL']).optional(),
  timestamp: z.string().datetime().optional()
});
const zoneSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(2).max(50),
  type: z.enum(['RESPAWN','OBJECTIVE','SAFE','EXTRACTION','FLAG','CONTROL','DANGER','CHECKPOINT','BOMB_SITE','SUPPLY','MEDICAL','START','HILL']),
  team: z.enum(['ALL','SERE','OPFOR']), center: z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]),
  radius: z.number().int().min(10).max(10_000), color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#a3ff4f'),
  shape: z.enum(['CIRCLE','POLYGON']).default('CIRCLE'),
  points: z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).max(100).optional(),
  sequence: z.number().int().min(1).max(100).optional(), objectiveId: z.string().uuid().nullable().optional(),
  ownerTeam: z.enum(['SERE','OPFOR']).nullable().optional(), carrierParticipantId: z.string().uuid().nullable().optional(),
  capturingTeam: z.enum(['SERE','OPFOR']).nullable().optional(), captureStartedAt: z.number().nullable().optional(), captureEndsAt: z.number().nullable().optional(),
  completedByTeam: z.enum(['SERE','OPFOR']).nullable().optional(), completedAt: z.number().nullable().optional(),
  bombState: z.enum(['IDLE','PLANTING','PLANTED','DEFUSING','DEFUSED','DETONATED']).optional(),
  bombAttackerTeam: z.enum(['SERE','OPFOR']).nullable().optional(), plantedByParticipantId: z.string().uuid().nullable().optional(),
  defusedByParticipantId: z.string().uuid().nullable().optional(), plantStartedAt: z.number().nullable().optional(), plantEndsAt: z.number().nullable().optional(),
  bombPlantedAt: z.number().nullable().optional(), bombEndsAt: z.number().nullable().optional(), defuseStartedAt: z.number().nullable().optional(), defuseEndsAt: z.number().nullable().optional()
}).superRefine((zone, context) => {
  if (zone.shape === 'POLYGON' && (!zone.points || zone.points.length < 3)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['points'], message: 'Strefa wielokątna wymaga co najmniej 3 punktów.' });
});
const objectiveSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).optional(), team: z.enum(['ALL','SERE','OPFOR']), points: z.number().int().min(0).max(10_000), status: z.enum(['PENDING','ACTIVE','COMPLETED','FAILED']), zoneId: z.string().uuid().nullable().optional(), progress: z.number().min(0).max(100).optional(), visibility: z.enum(['ALL','TEAM','COMMAND','GM']).optional() });
const modeSettingsSchema = z.object({
  hitsToRespawn: z.number().int().min(1).max(20), respawnSeconds: z.number().int().min(5).max(1800),
  respawnZoneRequired: z.boolean(), lives: z.number().int().min(0).max(100), scoreLimit: z.number().int().min(0).max(100_000),
  roundMinutes: z.number().int().min(5).max(1440), fovRange: z.number().int().min(20).max(1000), fovAngle: z.number().int().min(20).max(160),
  modeRules: z.record(z.union([z.number().min(0).max(100_000), z.boolean(), z.string().max(100)])).optional()
});
const settingsSchema = z.object({
  name: z.string().trim().min(3).max(100).optional(),
  durationMinutes: z.number().int().min(10).max(2880).optional(),
  sereTimerSeconds: z.number().int().min(5).max(600).optional(),
  opforTimerSeconds: z.number().int().min(5).max(600).optional(),
  boundary: z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).min(3).max(100).optional(),
  mode: z.enum(Object.keys(GAME_MODES)).optional(), modeSettings: modeSettingsSchema.partial().optional(),
  zones: z.array(zoneSchema).max(100).optional(), objectives: z.array(objectiveSchema).max(100).optional(),
  features: z.object(Object.fromEntries(FEATURE_KEYS.map(key => [key, z.boolean().optional()]))).strict().optional()
}).refine(value => Object.keys(value).length > 0);
const codeSchema = z.object({ code: z.string().trim().min(4).max(16).regex(/^[A-Za-z0-9_-]+$/).transform(value => value.toUpperCase()) });
const createGameSchema = z.object({
  code: z.string().trim().min(4).max(16).regex(/^[A-Za-z0-9_-]+$/).transform(value => value.toUpperCase()),
  name: z.string().trim().min(3).max(100),
  cloneSettingsFrom: z.string().uuid().optional()
});
const participantUpdateSchema = z.object({
  status: z.enum(['WAITING','READY','ACTIVE','TIMER','RESPAWN_WAIT','RESPAWN','CAPTURED','OUTSIDE','SOS','DISCONNECTED','FINISHED','REMOVED']).optional(),
  team: z.enum(['SERE','OPFOR']).optional(), role: z.string().trim().min(2).max(24).regex(/^[A-Z0-9_-]+$/).optional(), squadId: z.string().uuid().nullable().optional(),
  hitCount: z.number().int().min(0).max(100).optional(), respawnRequired: z.boolean().optional(), mapAccess: z.boolean().optional()
}).refine(value => Object.keys(value).length > 0);
const teamSchema = z.object({
  id:z.string().uuid(), code:z.string().trim().min(2).max(16).regex(/^[A-Za-z0-9_-]+$/).transform(value=>value.toUpperCase()),
  name:z.string().trim().min(2).max(50), side:z.enum(['SERE','OPFOR']), color:z.string().regex(/^#[0-9a-f]{6}$/i),
  mapSharing:z.enum(['NONE','SQUAD','SIDE']), respawnSeconds:z.number().int().min(5).max(1800).nullable(),
  maxPlayers:z.number().int().min(1).max(500), radioChannel:z.string().trim().max(30), active:z.boolean(),
  allowedRoles:z.array(z.string().trim().min(2).max(24)).max(50)
});
const roleSchema = z.object({
  code:z.string().trim().min(2).max(24).regex(/^[A-Za-z0-9_-]+$/).transform(value=>value.toUpperCase()),
  name:z.string().trim().min(2).max(50), icon:z.string().trim().min(1).max(4), color:z.string().regex(/^#[0-9a-f]{6}$/i),
  description:z.string().trim().max(300), capabilities:z.array(z.enum(ROLE_CAPABILITIES)).max(ROLE_CAPABILITIES.length), active:z.boolean()
});
const permissionSchema = z.array(z.enum(STAFF_PERMISSIONS)).max(STAFF_PERMISSIONS.length);
const createStaffSchema = z.object({
  gameId: z.string().uuid(), username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_.-]+$/).transform(value => value.toLowerCase()),
  callsign: z.string().trim().min(2).max(32), password: z.string().min(8).max(128), team: z.enum(['ALL','SERE','OPFOR']),
  title: z.string().trim().min(2).max(50).default('Dowódca'), permissions: permissionSchema
});
const updateStaffSchema = z.object({ callsign: z.string().trim().min(2).max(32).optional(), title: z.string().trim().min(2).max(50).optional(), team: z.enum(['ALL','SERE','OPFOR']).optional(), permissions: permissionSchema.optional(), active: z.boolean().optional(), password: z.string().min(8).max(128).optional() }).refine(value => Object.keys(value).length > 0);

function sign(payload, expiresIn = '12h') { return jwt.sign(payload, JWT_SECRET, { expiresIn }); }
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    req.auth = jwt.verify(token, JWT_SECRET); next();
  } catch { res.status(401).json({ error: 'Brak ważnej sesji.' }); }
}
function requireRole(...roles) { return (req, res, next) => roles.includes(req.auth?.role) ? next() : res.status(403).json({ error: 'Brak uprawnienia.' }); }
function effectiveViewer(viewer) {
  if (viewer?.role === 'PARTICIPANT') {
    const participant = store.participants.get(viewer.participantId);
    return participant ? { ...viewer, gameId: participant.gameId, team: participant.team, callsign: participant.callsign } : viewer;
  }
  if (viewer?.role !== 'STAFF') return viewer;
  const account = store.staff.get(viewer.staffId);
  return account?.active ? { ...viewer, gameId: account.gameId, team: account.team, permissions: account.permissions, callsign: account.callsign } : viewer;
}
function can(viewer, permission) { return viewer?.role === 'ADMIN' || effectiveViewer(viewer)?.permissions?.includes(permission); }
function requirePermission(permission) { return (req, res, next) => can(req.auth, permission) ? next() : res.status(403).json({ error: 'To konto nie ma wymaganego uprawnienia.' }); }
function event(gameId, type, details = {}, participantId = null, severity = 'INFO') {
  const item = { id: crypto.randomUUID(), gameId, participantId, type, severity, details, createdAt: new Date().toISOString() };
  store.events.unshift(item); io.to(`game:${gameId}:staff`).emit('event:new', item); persistSoon(); return item;
}
function participantRole(game, participant) { return game?.roles?.find(role => role.code === (participant?.role || 'OPERATOR')) || BUILTIN_ROLES.find(role => role.code === (participant?.role || 'OPERATOR')) || BUILTIN_ROLES[0]; }
function participantCapabilities(game, participant) { return feature(game, 'roleAbilities') ? (participantRole(game, participant)?.capabilities || []) : []; }
function participantTeam(game, participant) { return game?.teams?.find(team => team.id === participant?.squadId) || null; }
function participantRespawnSeconds(game, participant) { return participantTeam(game, participant)?.respawnSeconds || game?.modeSettings?.respawnSeconds || 60; }
function participantView(p) {
  const { token, ...safe } = p;
  const timer = p.activeTimer ? store.timers.get(p.activeTimer) : null;
  const game = store.games.get(p.gameId);
  return { ...safe, timerEnd: timer?.endsAt || null, capabilities:participantCapabilities(game, p) };
}
function staffView(account) { const { passwordHash, ...safe } = account; return safe; }
function feature(game, key) { return game?.features?.[key] ?? DEFAULT_FEATURES[key] ?? true; }
function visibleParticipants(gameId, viewer) {
  viewer = effectiveViewer(viewer);
  const game = store.games.get(gameId);
  const currentViewer = viewer.participantId ? store.participants.get(viewer.participantId) : null;
  const effectiveTeam = currentViewer?.team || viewer.team;
  return [...store.participants.values()].filter(p => p.gameId === gameId).filter(p => {
    if (viewer.role === 'ADMIN' || can(viewer, 'VIEW_ALL_PLAYERS')) return true;
    if (viewer.role === 'STAFF' && can(viewer, 'VIEW_TEAM_PLAYERS')) return viewer.team === 'ALL' || p.team === viewer.team;
    if (p.activeSos) return true;
    if (p.id === viewer.participantId) return true;
    if (viewer.role === 'PARTICIPANT' && currentViewer && p.team === currentViewer.team) {
      const capabilities = participantCapabilities(game, currentViewer);
      if (capabilities.includes('TEAM_MAP') || capabilities.includes('COMMAND') || capabilities.includes('REVIVE') || capabilities.includes('RECON') || capabilities.includes('RESPAWN_MANAGER')) return true;
      const squad = participantTeam(game, currentViewer);
      if (squad?.mapSharing === 'SIDE') return true;
      if (squad?.mapSharing === 'SQUAD') return Boolean(currentViewer.squadId && p.squadId === currentViewer.squadId);
      if (squad?.mapSharing === 'NONE') return false;
    }
    return feature(game, 'opforTeamMap') && effectiveTeam === 'OPFOR' && p.team === 'OPFOR';
  }).map(p => {
    const view = participantView(p);
    if (viewer.role === 'STAFF' && !can(viewer, 'VIEW_FOV') && view.location) {
      view.location = { ...view.location, heading: null, headingSource: undefined, speed: undefined };
    }
    if (viewer.role === 'STAFF' && !can(viewer, 'VIEW_COORDINATES')) view.location = null;
    if (viewer.role === 'STAFF' && !can(viewer, 'VIEW_BATTERY')) view.battery = null;
    if (viewer.role === 'STAFF' && !can(viewer, 'VIEW_ACCURACY') && view.location) view.location = { ...view.location, accuracy: null };
    if (viewer.role === 'STAFF' && !can(viewer, 'VIEW_PLAYER_STATUS')) {
      view.status = 'HIDDEN'; view.hitCount = null; view.respawnCount = null; view.respawnRequired = null; view.timerEnd = null;
    }
    if (view.carriedFlagId) {
      const flagVisibility = game.modeSettings?.modeRules?.flagCarrierVisibility || (game.modeSettings?.modeRules?.carrierVisible ? 'ALL' : 'COMMAND');
      const maySeeFlag = viewer.role === 'ADMIN' || p.id === viewer.participantId || flagVisibility === 'ALL' || (flagVisibility === 'TEAM' && effectiveTeam === p.team) || (viewer.role === 'STAFF' && can(viewer, 'VIEW_MODE_INTEL'));
      if (!maySeeFlag) view.carriedFlagId = null;
    }
    return view;
  });
}
function messageVisibleTo(message, viewer) {
  viewer = effectiveViewer(viewer);
  if (viewer.role === 'ADMIN') return true;
  if (viewer.role === 'STAFF') {
    if (message.senderStaffId === viewer.staffId || message.recipientStaffId === viewer.staffId) return true;
    if (message.audience === 'ALL' || message.audience === viewer.team) return true;
    return message.audience === 'STAFF' && !message.recipientStaffId;
  }
  return message.senderParticipantId === viewer.participantId || message.recipientParticipantId === viewer.participantId || message.audience === 'ALL' || message.audience === viewer.team;
}
function visibleMessages(gameId, viewer) {
  return store.messages.filter(message => message.gameId === gameId && messageVisibleTo(message, viewer)).slice(-300).reverse();
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
function distanceMeters(lat1, lon1, lat2, lon2) { const r = 6371000, p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dp = (lat2-lat1)*Math.PI/180, dl=(lon2-lon1)*Math.PI/180, a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2; return 2*r*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); }
function participantInsideZone(participant, zone) {
  if (!participant?.location || !zone) return false;
  return zone.shape === 'POLYGON' && zone.points?.length >= 3
    ? pointInPolygon(participant.location.latitude, participant.location.longitude, zone.points)
    : distanceMeters(participant.location.latitude, participant.location.longitude, zone.center[0], zone.center[1]) <= zone.radius;
}
function inRespawnZone(game, participant) {
  if (!game.modeSettings?.respawnZoneRequired) return true;
  if (!participant.location) return false;
  return game.zones.some(zone => {
    if (zone.type !== 'RESPAWN' || (zone.team !== 'ALL' && zone.team !== participant.team)) return false;
    if (zone.shape === 'POLYGON' && zone.points?.length >= 3) return pointInPolygon(participant.location.latitude, participant.location.longitude, zone.points);
    return distanceMeters(participant.location.latitude, participant.location.longitude, zone.center[0], zone.center[1]) <= zone.radius;
  });
}
function activeSos(gameId) {
  return [...store.sos.values()].filter(s => s.gameId === gameId && ['ACTIVE','ACKNOWLEDGED'].includes(s.status));
}
function finishTimer(timer) {
  const current = store.timers.get(timer.id), p = current && store.participants.get(current.participantId);
  if (!current || current.completedAt || !p) return;
  current.completedAt = Date.now(); p.activeTimer = null; p.status = 'ACTIVE';
  if (current.kind === 'RESPAWN' || p.respawnRequired) { p.respawnRequired = false; p.hitCount = 0; p.respawnCount = (p.respawnCount || 0) + 1; }
  event(current.gameId, 'TIMER_FINISHED', { callsign: p.callsign }, p.id); timerTimeouts.delete(current.id); broadcastState(current.gameId);
}
function scheduleTimer(timer) {
  clearTimeout(timerTimeouts.get(timer.id));
  timerTimeouts.set(timer.id, setTimeout(() => finishTimer(timer), Math.max(0, timer.endsAt - Date.now())));
}
function updateActiveTimerDurations(game, changes) {
  for (const timer of store.timers.values()) {
    if (timer.gameId !== game.id || timer.completedAt) continue;
    const p = store.participants.get(timer.participantId); if (!p) continue;
    const kind = timer.kind || (p.respawnRequired ? 'RESPAWN' : p.team === 'SERE' ? 'SERE' : 'OPFOR');
    const seconds = kind === 'RESPAWN' ? (participantTeam(game, p)?.respawnSeconds || changes.modeSettings?.respawnSeconds) : kind === 'SERE' ? changes.sereTimerSeconds : changes.opforTimerSeconds;
    if (!Number.isFinite(seconds)) continue;
    timer.kind = kind; timer.seconds = seconds; timer.endsAt = timer.startedAt + seconds * 1000; scheduleTimer(timer);
  }
}
function gameForViewer(game, viewer) {
  viewer = effectiveViewer(viewer);
  if (!game) return game;
  const current = viewer.participantId ? store.participants.get(viewer.participantId) : null;
  const visibility = game.modeSettings?.modeRules?.flagCarrierVisibility || (game.modeSettings?.modeRules?.carrierVisible ? 'ALL' : 'COMMAND');
  const maySeeCarrier = viewer.role === 'ADMIN' || (viewer.role === 'STAFF' && can(viewer, 'VIEW_MODE_INTEL')) || visibility === 'ALL';
  const objectives = (game.objectives || []).filter(objective => {
    const visibility = objective.visibility || 'ALL';
    if (viewer.role === 'ADMIN' || visibility === 'ALL') return true;
    if (viewer.role === 'STAFF') return visibility === 'COMMAND' || can(viewer, 'VIEW_MODE_INTEL') || (visibility === 'TEAM' && (viewer.team === 'ALL' || viewer.team === objective.team));
    return visibility === 'TEAM' && (objective.team === 'ALL' || current?.team === objective.team);
  });
  return { ...game, objectives, zones: (game.zones || []).map(zone => {
    if (!zone.carrierParticipantId || maySeeCarrier) return zone;
    const carrier = store.participants.get(zone.carrierParticipantId);
    if (visibility === 'TEAM' && current?.team === carrier?.team) return zone;
    return { ...zone, carrierParticipantId: null };
  }) };
}
function archiveSummary(archive) {
  return { id:archive.id, gameId:archive.gameId, label:archive.label, automatic:archive.automatic, createdAt:archive.createdAt, participantCount:archive.participants.length, eventCount:archive.events.length, messageCount:archive.messages.length, trackCount:archive.tracks.length, state:archive.game.state, mode:archive.game.mode };
}
function createArchive(game, label = '', automatic = false) {
  const createdAt = new Date().toISOString();
  const archive = {
    id:crypto.randomUUID(), gameId:game.id, label:label.trim() || `${game.code} · ${new Date().toLocaleString('pl-PL')}`, automatic, createdAt,
    game:structuredClone(game),
    participants:[...store.participants.values()].filter(item=>item.gameId===game.id).map(item=>participantView(item)),
    events:structuredClone(store.events.filter(item=>item.gameId===game.id)),
    messages:structuredClone(store.messages.filter(item=>item.gameId===game.id)),
    tracks:structuredClone(store.tracks.filter(item=>item.gameId===game.id)),
    sos:structuredClone([...store.sos.values()].filter(item=>item.gameId===game.id))
  };
  store.archives.unshift(archive); if (store.archives.length > 500) store.archives.length = 500;
  event(game.id, 'SESSION_ARCHIVED', { archiveId:archive.id, label:archive.label, automatic }); persistSoon();
  return archive;
}
function snapshot(gameId, viewer) {
  viewer = effectiveViewer(viewer);
  const isStaff = viewer.role === 'STAFF';
  return {
    game: gameForViewer(store.games.get(gameId), viewer),
    participants: visibleParticipants(gameId, viewer),
    sos: viewer.role === 'ADMIN' || can(viewer, 'VIEW_SOS') || viewer.role === 'PARTICIPANT' ? activeSos(gameId) : [],
    events: viewer.role === 'ADMIN' || can(viewer, 'VIEW_EVENTS') ? store.events.filter(e => e.gameId === gameId).slice(0, 200) : [],
    messages: visibleMessages(gameId, viewer),
    contacts: [...store.staff.values()].filter(account => account.gameId === gameId && account.active && account.permissions.includes('RECEIVE_PLAYER_MESSAGES')).map(account => ({ id: account.id, callsign: account.callsign, title: account.title, team: account.team })),
    staff: viewer.role === 'ADMIN' ? [...store.staff.values()].filter(account => account.gameId === gameId).map(staffView) : undefined,
    currentStaff: isStaff ? staffView(store.staff.get(viewer.staffId)) : undefined,
    archives: viewer.role === 'ADMIN' || can(viewer, 'VIEW_REPORTS') ? store.archives.filter(item=>item.gameId===gameId).map(archiveSummary) : undefined
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, now: new Date().toISOString(), sockets: io.engine.clientsCount }));
app.get('/api/game-modes', (_req, res) => res.json(GAME_MODES));
app.get('/api/presets', (_req, res) => res.json(SESSION_PRESETS));
app.get('/api/permissions', auth, requireRole('ADMIN'), (_req, res) => res.json(STAFF_PERMISSIONS));
app.get('/api/games/:code/public', (req, res) => {
  const game = gameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Nie znaleziono sesji.' });
  res.json({ id: game.id, code: game.code, name: game.name, state: game.state, mode: game.mode, modeSettings: game.modeSettings, features: game.features, teams:(game.teams||[]).filter(team=>team.active), roles:(game.roles||[]).filter(role=>role.active), participantCount: [...store.participants.values()].filter(p => p.gameId === game.id).length });
});
app.get('/api/games', auth, requireRole('ADMIN'), (_req, res) => {
  res.json([...store.games.values()].map(game => ({
    id: game.id, code: game.code, name: game.name, state: game.state, createdAt: game.createdAt,
    participantCount: [...store.participants.values()].filter(p => p.gameId === game.id).length
  })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
});
app.post('/api/games', auth, requireRole('ADMIN'), (req, res) => {
  const parsed = createGameSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Kod sesji musi mieć 4–16 znaków (litery, cyfry, _ lub -).' });
  if (gameByCode(parsed.data.code)) return res.status(409).json({ error: 'Ten kod sesji jest już używany.' });
  const source = parsed.data.cloneSettingsFrom ? store.games.get(parsed.data.cloneSettingsFrom) : demoGame;
  const game = makeGame({ code: parsed.data.code, name: parsed.data.name, source });
  store.games.set(game.id, game); event(game.id, 'SESSION_CREATED', { code: game.code, name: game.name });
  persistSoon(); res.status(201).json(game);
});
app.post('/api/auth/admin', async (req, res) => {
  const callsignOk = String(req.body?.callsign || '').toUpperCase() === ADMIN_CALLSIGN.toUpperCase();
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 8);
  const passwordOk = await bcrypt.compare(String(req.body?.password || ''), passwordHash);
  if (!callsignOk || !passwordOk) return res.status(401).json({ error: 'Nieprawidłowe dane.' });
  res.json({ token: sign({ role: 'ADMIN', callsign: ADMIN_CALLSIGN }), role: 'ADMIN', gameId: demoGame.id });
});
app.post('/api/auth/staff', async (req, res) => {
  const parsed = z.object({ code: z.string().trim().min(4).max(16), username: z.string().trim().min(3).max(32), password: z.string().min(1).max(128) }).safeParse(req.body);
  const game = parsed.success ? gameByCode(parsed.data.code) : null;
  const account = game && [...store.staff.values()].find(item => item.gameId === game.id && item.username === parsed.data.username.toLowerCase() && item.active);
  if (!account || !(await bcrypt.compare(parsed.data.password, account.passwordHash))) return res.status(401).json({ error: 'Nieprawidłowy kod sesji, login lub hasło.' });
  account.lastLoginAt = new Date().toISOString(); persistSoon();
  res.json({ token: sign({ role: 'STAFF', staffId: account.id, gameId: game.id }), role: 'STAFF', gameId: game.id, staff: staffView(account) });
});
app.get('/api/staff', auth, requireRole('ADMIN'), (req, res) => {
  const gameId = String(req.query.gameId || '');
  res.json([...store.staff.values()].filter(account => account.gameId === gameId).map(staffView));
});
app.post('/api/staff', auth, requireRole('ADMIN'), async (req, res) => {
  const parsed = createStaffSchema.safeParse(req.body);
  if (!parsed.success || !store.games.has(parsed.data?.gameId)) return res.status(400).json({ error: 'Nieprawidłowe dane konta personelu.' });
  if ([...store.staff.values()].some(account => account.gameId === parsed.data.gameId && account.username === parsed.data.username)) return res.status(409).json({ error: 'Ten login jest już zajęty w tej sesji.' });
  const account = { id: crypto.randomUUID(), ...parsed.data, passwordHash: await bcrypt.hash(parsed.data.password, 10), active: true, createdAt: new Date().toISOString() };
  delete account.password; store.staff.set(account.id, account); event(account.gameId, 'STAFF_CREATED', { callsign: account.callsign, title: account.title });
  persistSoon(); res.status(201).json(staffView(account));
});
app.patch('/api/staff/:id', auth, requireRole('ADMIN'), async (req, res) => {
  const parsed = updateStaffSchema.safeParse(req.body), account = store.staff.get(req.params.id);
  if (!parsed.success || !account) return res.status(400).json({ error: 'Nieprawidłowa zmiana konta.' });
  const updates = { ...parsed.data }; if (updates.password) { updates.passwordHash = await bcrypt.hash(updates.password, 10); delete updates.password; }
  Object.assign(account, updates, { updatedAt: new Date().toISOString() }); event(account.gameId, 'STAFF_CHANGED', { callsign: account.callsign });
  broadcastState(account.gameId); res.json(staffView(account));
});
app.delete('/api/staff/:id', auth, requireRole('ADMIN'), (req, res) => {
  const account = store.staff.get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Nie znaleziono konta personelu.' });
  store.staff.delete(account.id);
  event(account.gameId, 'STAFF_DELETED', { callsign: account.callsign, username: account.username }, null, 'WARNING');
  broadcastState(account.gameId); persistSoon(); res.status(204).end();
});
app.post('/api/games/:code/join', (req, res) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Sprawdź kryptonim, drużynę i zgody.', issues: parsed.error.issues });
  const game = gameByCode(req.params.code);
  if (!game || !['LOBBY', 'DRAFT'].includes(game.state) || !feature(game, 'allowJoining')) return res.status(409).json({ error: 'Do tej sesji nie można teraz dołączyć.' });
  const normalized = parsed.data.callsign.toLocaleUpperCase('pl-PL');
  const duplicate = [...store.participants.values()].some(p => p.gameId === game.id && p.normalizedCallsign === normalized);
  const squad = parsed.data.squadId ? game.teams?.find(team=>team.id===parsed.data.squadId) : null;
  if (parsed.data.squadId && (!squad || !squad.active || squad.side !== parsed.data.team)) return res.status(409).json({ error: 'Wybrana drużyna operacyjna nie jest dostępna dla tej strony.' });
  if (squad && [...store.participants.values()].filter(item=>item.gameId===game.id && item.squadId===squad.id && item.status!=='REMOVED').length >= squad.maxPlayers) return res.status(409).json({ error: 'Wybrana drużyna osiągnęła limit uczestników.' });
  if (duplicate) return res.status(409).json({ error: 'Ten kryptonim jest już zajęty.' });
  const participant = {
    id: crypto.randomUUID(), gameId: game.id, callsign: parsed.data.callsign, normalizedCallsign: normalized,
    team: parsed.data.team, squadId:squad?.id || null, role: 'OPERATOR', status: 'READY', consentVersion: parsed.data.consentVersion,
    consentedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), location: null,
    timerCount: 0, boundaryCount: 0, hitCount: 0, respawnCount: 0, respawnRequired: false, activeSos: false, mapAccess: true
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
app.get('/api/games/:id/archives', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const game=store.games.get(req.params.id);
  if (!game) return res.status(404).json({ error:'Nie znaleziono sesji.' });
  if (req.auth.role==='STAFF' && (req.auth.gameId!==game.id || !can(req.auth,'VIEW_REPORTS'))) return res.status(403).json({ error:'Brak uprawnienia do archiwów.' });
  res.json(store.archives.filter(item=>item.gameId===game.id).map(archiveSummary));
});
app.post('/api/games/:id/archives', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const game=store.games.get(req.params.id), parsed=z.object({ label:z.string().trim().max(100).optional() }).safeParse(req.body||{});
  if (!game || !parsed.success) return res.status(400).json({ error:'Nieprawidłowy zapis sesji.' });
  if (req.auth.role==='STAFF' && (req.auth.gameId!==game.id || !can(req.auth,'EXPORT_REPORTS'))) return res.status(403).json({ error:'Brak uprawnienia do zapisu archiwum.' });
  res.status(201).json(archiveSummary(createArchive(game,parsed.data.label,false)));
});
app.get('/api/games/:id/archives/:archiveId', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const archive=store.archives.find(item=>item.id===req.params.archiveId && item.gameId===req.params.id);
  if (!archive) return res.status(404).json({ error:'Nie znaleziono archiwum.' });
  if (req.auth.role==='STAFF' && (req.auth.gameId!==archive.gameId || !can(req.auth,'VIEW_REPORTS'))) return res.status(403).json({ error:'Brak uprawnienia do archiwum.' });
  res.json(archive);
});
app.delete('/api/games/:id/archives/:archiveId', auth, requireRole('ADMIN'), (req, res) => {
  const index=store.archives.findIndex(item=>item.id===req.params.archiveId && item.gameId===req.params.id);
  if (index<0) return res.status(404).json({ error:'Nie znaleziono archiwum.' });
  const [removed]=store.archives.splice(index,1); event(req.params.id,'SESSION_ARCHIVE_DELETED',{ archiveId:removed.id, label:removed.label },null,'WARNING'); persistSoon(); res.status(204).end();
});
app.get('/api/games/:id/replay', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const game = store.games.get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Nie znaleziono sesji.' });
  if (req.auth.role === 'STAFF' && (!can(req.auth, 'VIEW_REPLAY') || req.auth.gameId !== game.id)) return res.status(403).json({ error: 'Brak uprawnienia do zapisu trasy.' });
  const participantIndex = new Map([...store.participants.values()].filter(p => p.gameId === game.id).map(p => [p.id, { id: p.id, callsign: p.callsign, team: p.team, role: p.role || 'OPERATOR' }]));
  for (const point of store.tracks) if (point.gameId === game.id && !participantIndex.has(point.participantId)) participantIndex.set(point.participantId, { id: point.participantId, callsign: point.callsign || 'GRACZ', team: point.team || 'SERE', role: point.role || 'OPERATOR' });
  const participants = [...participantIndex.values()];
  res.json({ game: { id: game.id, code: game.code, name: game.name, startedAt: game.startedAt, finishedAt: game.finishedAt }, participants, tracks: store.tracks.filter(point => point.gameId === game.id) });
});
app.delete('/api/games/:id/replay', auth, requireRole('ADMIN'), (req, res) => {
  const game = store.games.get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Nie znaleziono sesji.' });
  const before = store.tracks.length;
  store.tracks = store.tracks.filter(point => point.gameId !== game.id);
  const deleted = before - store.tracks.length;
  event(game.id, 'REPLAY_CLEARED', { deleted });
  broadcastState(game.id); persistSoon();
  res.json({ deleted });
});
app.patch('/api/games/:id/settings', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  const game = store.games.get(req.params.id);
  if (!parsed.success || !game) return res.status(400).json({ error: 'Nieprawidłowe ustawienia gry.' });
  if (req.auth.role === 'STAFF' && (req.auth.gameId !== game.id || !can(req.auth, 'MANAGE_MODE_RULES') || Object.keys(parsed.data).some(key => !['mode','modeSettings'].includes(key)))) return res.status(403).json({ error: 'Personel może zmieniać wyłącznie reguły trybu z odpowiednim uprawnieniem.' });
  if (game.state === 'ACTIVE' && parsed.data.boundary) return res.status(409).json({ error: 'Wstrzymaj grę przed zmianą granicy terenu.' });
  if (parsed.data.mode) {
    const defaults = defaultModeSettings(parsed.data.mode);
    parsed.data.modeSettings = { ...defaults, ...(parsed.data.modeSettings || {}), modeRules: { ...defaults.modeRules, ...(parsed.data.modeSettings?.modeRules || {}) } };
  } else if (parsed.data.modeSettings) {
    parsed.data.modeSettings = { ...game.modeSettings, ...parsed.data.modeSettings, modeRules: { ...(game.modeSettings?.modeRules || {}), ...(parsed.data.modeSettings.modeRules || {}) } };
  }
  if (parsed.data.features) parsed.data.features = { ...game.features, ...parsed.data.features };
  Object.assign(game, parsed.data);
  updateActiveTimerDurations(game, parsed.data);
  event(game.id, 'GAME_SETTINGS_CHANGED', { fields: Object.keys(parsed.data) });
  broadcastState(game.id);
  io.to(`game:${game.id}`).emit('game:changed', game);
  res.json(game);
});
app.patch('/api/games/:id/code', auth, requireRole('ADMIN'), (req, res) => {
  const parsed = codeSchema.safeParse(req.body), game = store.games.get(req.params.id);
  if (!parsed.success || !game) return res.status(400).json({ error: 'Kod musi mieć 4–16 znaków: litery, cyfry, _ lub -.' });
  if ([...store.games.values()].some(item => item.id !== game.id && item.code === parsed.data.code)) return res.status(409).json({ error: 'Ten kod sesji jest już używany.' });
  const previousCode = game.code; game.code = parsed.data.code; event(game.id, 'SESSION_CODE_CHANGED', { previousCode, code: game.code }); broadcastState(game.id); res.json(game);
});
app.patch('/api/games/:id/teams', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const parsed = z.object({ teams:z.array(teamSchema).max(30) }).safeParse(req.body), game = store.games.get(req.params.id);
  if (!parsed.success || !game) return res.status(400).json({ error:'Nieprawidłowa konfiguracja drużyn.', issues:parsed.error?.issues });
  if (req.auth.role==='STAFF' && (req.auth.gameId!==game.id || !can(req.auth,'MANAGE_TEAMS'))) return res.status(403).json({ error:'Brak uprawnienia do drużyn.' });
  if (new Set(parsed.data.teams.map(team=>team.id)).size!==parsed.data.teams.length || new Set(parsed.data.teams.map(team=>team.code)).size!==parsed.data.teams.length) return res.status(409).json({ error:'Identyfikatory i kody drużyn muszą być unikalne.' });
  const roleCodes = new Set((game.roles||[]).map(role=>role.code));
  if (parsed.data.teams.some(team=>team.allowedRoles.some(role=>!roleCodes.has(role)))) return res.status(409).json({ error:'Drużyna odwołuje się do nieistniejącej roli.' });
  if (parsed.data.teams.some(team=>!team.allowedRoles.includes('OPERATOR'))) return res.status(409).json({ error:'Każda drużyna musi dopuszczać rolę Operator, aby można było do niej dołączyć.' });
  const nextIds = new Set(parsed.data.teams.map(team=>team.id));
  const nextTeams=new Map(parsed.data.teams.map(team=>[team.id,team]));
  for (const participant of store.participants.values()) if (participant.gameId===game.id && participant.squadId && (!nextIds.has(participant.squadId)||nextTeams.get(participant.squadId)?.side!==participant.team)) participant.squadId=null;
  game.teams=parsed.data.teams;
  event(game.id,'TEAMS_CHANGED',{ count:game.teams.length }); broadcastState(game.id); res.json(game);
});
app.patch('/api/games/:id/roles', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const parsed = z.object({ roles:z.array(roleSchema).min(1).max(50) }).safeParse(req.body), game = store.games.get(req.params.id);
  if (!parsed.success || !game) return res.status(400).json({ error:'Nieprawidłowa konfiguracja ról.', issues:parsed.error?.issues });
  if (req.auth.role==='STAFF' && (req.auth.gameId!==game.id || !can(req.auth,'MANAGE_TEAMS'))) return res.status(403).json({ error:'Brak uprawnienia do ról.' });
  if (new Set(parsed.data.roles.map(role=>role.code)).size!==parsed.data.roles.length || !parsed.data.roles.some(role=>role.code==='OPERATOR' && role.active)) return res.status(409).json({ error:'Kody ról muszą być unikalne, a aktywna rola OPERATOR jest wymagana.' });
  const codes = new Set(parsed.data.roles.map(role=>role.code));
  for (const participant of store.participants.values()) if (participant.gameId===game.id && !codes.has(participant.role||'OPERATOR')) participant.role='OPERATOR';
  game.teams=(game.teams||[]).map(team=>({ ...team, allowedRoles:team.allowedRoles.filter(code=>codes.has(code)) }));
  game.roles=parsed.data.roles;
  event(game.id,'ROLES_CHANGED',{ count:game.roles.length }); broadcastState(game.id); res.json(game);
});
app.post('/api/games/:id/presets/:key/apply', auth, requireRole('ADMIN'), (req, res) => {
  const game=store.games.get(req.params.id), preset=SESSION_PRESETS[req.params.key];
  if (!game || !preset) return res.status(404).json({ error:'Nie znaleziono sesji lub presetu.' });
  if (game.state==='ACTIVE') return res.status(409).json({ error:'Wstrzymaj grę przed zastosowaniem presetu.' });
  const defaults=defaultModeSettings(preset.mode), modeSettings={ ...defaults, ...(preset.modeSettings||{}), modeRules:{ ...defaults.modeRules, ...(preset.modeSettings?.modeRules||{}) } };
  Object.assign(game,{ mode:preset.mode, modeSettings, durationMinutes:preset.durationMinutes, sereTimerSeconds:preset.sereTimerSeconds, opforTimerSeconds:preset.opforTimerSeconds, features:{ ...game.features, ...(preset.features||{}) } });
  event(game.id,'SESSION_PRESET_APPLIED',{ key:req.params.key, name:preset.name }); broadcastState(game.id); res.json(game);
});
app.patch('/api/games/:id/zones', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const parsed = z.object({ zones: z.array(zoneSchema).max(100) }).safeParse(req.body), game = store.games.get(req.params.id);
  if (!parsed.success || !game) return res.status(400).json({ error: 'Nieprawidłowe strefy.' });
  if (req.auth.role === 'STAFF' && (!can(req.auth, 'MANAGE_ZONES') || req.auth.gameId !== game.id)) return res.status(403).json({ error: 'Brak uprawnienia do stref.' });
  if (req.auth.role === 'STAFF' && parsed.data.zones.some(zone => zone.type === 'FLAG') && !can(req.auth, 'MANAGE_FLAGS')) return res.status(403).json({ error: 'Brak uprawnienia do flag.' });
  if (req.auth.role === 'STAFF' && parsed.data.zones.some(zone => zone.type === 'CHECKPOINT') && !can(req.auth, 'MANAGE_CHECKPOINTS')) return res.status(403).json({ error: 'Brak uprawnienia do checkpointów.' });
  const existingZones = new Map((game.zones || []).map(zone => [zone.id, zone]));
  const nextIds = new Set(parsed.data.zones.map(zone => zone.id));
  for (const oldZone of game.zones || []) if (!nextIds.has(oldZone.id)) {
    clearTimeout(zoneTimeouts.get(oldZone.id)); zoneTimeouts.delete(oldZone.id);
    for (const suffix of ['plant','explode','defuse']) { clearTimeout(bombTimeouts.get(`${oldZone.id}:${suffix}`)); bombTimeouts.delete(`${oldZone.id}:${suffix}`); }
  }
  game.zones = parsed.data.zones.map(zone => existingZones.has(zone.id) ? Object.assign(existingZones.get(zone.id), zone) : zone);
  event(game.id, 'ZONES_CHANGED', { count: game.zones.length }); broadcastState(game.id); res.json(game);
});
app.patch('/api/games/:id/objectives', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const parsed = z.object({ objectives: z.array(objectiveSchema).max(100) }).safeParse(req.body), game = store.games.get(req.params.id);
  if (!parsed.success || !game) return res.status(400).json({ error: 'Nieprawidłowe cele.' });
  if (req.auth.role === 'STAFF' && (!can(req.auth, 'MANAGE_OBJECTIVES') || req.auth.gameId !== game.id)) return res.status(403).json({ error: 'Brak uprawnienia do celów.' });
  game.objectives = parsed.data.objectives; event(game.id, 'OBJECTIVES_CHANGED', { count: game.objectives.length }); broadcastState(game.id); res.json(game);
});
app.post('/api/zones/:id/interact', auth, requireRole('PARTICIPANT'), (req, res) => {
  const p = store.participants.get(req.auth.participantId), game = store.games.get(p?.gameId), zone = game?.zones?.find(item => item.id === req.params.id);
  if (!p || !game || !zone || !feature(game, 'zoneInteractions')) return res.status(404).json({ error: 'Ta strefa nie jest dostępna.' });
  if (game.state !== 'ACTIVE') return res.status(409).json({ error: 'Interakcje stref działają podczas aktywnej gry.' });
  if (!participantInsideZone(p, zone)) return res.status(409).json({ error: 'Podejdź do strefy, aby wykonać tę akcję.' });
  if (zone.type === 'RESPAWN') return res.json({ action: 'RESPAWN_READY', zone, message: p.respawnRequired ? 'Możesz uruchomić timer respawnu.' : 'Jesteś w strefie respawnu.' });
  if (zone.type === 'BOMB_SITE') {
    const attackerTeam = zone.bombAttackerTeam || (zone.team === 'ALL' ? 'SERE' : zone.team);
    const defenderTeam = attackerTeam === 'SERE' ? 'OPFOR' : 'SERE';
    const state = zone.bombState || 'IDLE';
    if (p.team === attackerTeam) {
      if (state !== 'IDLE') return res.status(409).json({ error: state === 'PLANTED' || state === 'DEFUSING' ? 'Ładunek jest już podłożony.' : state === 'PLANTING' ? 'Podkładanie ładunku już trwa.' : 'Ta strefa została już rozstrzygnięta.' });
      const specialist = participantCapabilities(game,p).includes('BOMB_SPECIALIST');
      const seconds = Math.max(1, Math.ceil(Number(game.modeSettings?.modeRules?.plantSeconds || 15) * (specialist ? 0.65 : 1)));
      Object.assign(zone, { bombState:'PLANTING', bombAttackerTeam:attackerTeam, plantedByParticipantId:p.id, plantStartedAt:Date.now(), plantEndsAt:Date.now() + seconds * 1000, bombPlantedAt:null, bombEndsAt:null, defuseStartedAt:null, defuseEndsAt:null, defusedByParticipantId:null });
      clearTimeout(bombTimeouts.get(`${zone.id}:plant`));
      bombTimeouts.set(`${zone.id}:plant`, setTimeout(() => {
        const planter = store.participants.get(p.id);
        if (zone.bombState !== 'PLANTING' || zone.plantedByParticipantId !== p.id) return;
        if (!participantInsideZone(planter, zone)) {
          Object.assign(zone, { bombState:'IDLE', plantedByParticipantId:null, plantStartedAt:null, plantEndsAt:null });
          event(game.id, 'BOMB_PLANT_CANCELLED', { callsign:p.callsign, zone:zone.name }, p.id, 'WARNING');
          broadcastState(game.id); return;
        }
        const bombSeconds = Math.max(5, Number(game.modeSettings?.modeRules?.bombTimerSeconds || 300));
        Object.assign(zone, { bombState:'PLANTED', bombPlantedAt:Date.now(), bombEndsAt:Date.now() + bombSeconds * 1000, plantEndsAt:null });
        event(game.id, 'BOMB_PLANTED', { callsign:p.callsign, team:p.team, zone:zone.name, seconds:bombSeconds }, p.id, 'CRITICAL');
        broadcastState(game.id);
        clearTimeout(bombTimeouts.get(`${zone.id}:explode`));
        bombTimeouts.set(`${zone.id}:explode`, setTimeout(() => {
          if (!['PLANTED','DEFUSING'].includes(zone.bombState)) return;
          Object.assign(zone, { bombState:'DETONATED', bombEndsAt:null, defuseEndsAt:null });
          game.scores[attackerTeam] = (game.scores[attackerTeam] || 0) + 1;
          event(game.id, 'BOMB_DETONATED', { team:attackerTeam, zone:zone.name, score:game.scores[attackerTeam] }, p.id, 'CRITICAL');
          broadcastState(game.id);
        }, bombSeconds * 1000));
      }, seconds * 1000));
      event(game.id, 'BOMB_PLANT_STARTED', { callsign:p.callsign, team:p.team, zone:zone.name, seconds }, p.id, 'WARNING');
      broadcastState(game.id); return res.json({ action:'BOMB_PLANT_STARTED', zone, seconds });
    }
    if (p.team === defenderTeam) {
      if (state !== 'PLANTED') return res.status(409).json({ error: state === 'DEFUSING' ? 'Rozbrajanie ładunku już trwa.' : state === 'PLANTING' ? 'Ładunek nie został jeszcze podłożony.' : 'W tej strefie nie ma aktywnego ładunku.' });
      const specialist = participantCapabilities(game,p).includes('BOMB_SPECIALIST');
      const seconds = Math.max(1, Math.ceil(Number(game.modeSettings?.modeRules?.defuseSeconds || 20) * (specialist ? 0.65 : 1)));
      Object.assign(zone, { bombState:'DEFUSING', defusedByParticipantId:p.id, defuseStartedAt:Date.now(), defuseEndsAt:Date.now() + seconds * 1000 });
      clearTimeout(bombTimeouts.get(`${zone.id}:defuse`));
      bombTimeouts.set(`${zone.id}:defuse`, setTimeout(() => {
        const defender = store.participants.get(p.id);
        if (zone.bombState !== 'DEFUSING' || zone.defusedByParticipantId !== p.id) return;
        if (!participantInsideZone(defender, zone)) {
          Object.assign(zone, { bombState:'PLANTED', defusedByParticipantId:null, defuseStartedAt:null, defuseEndsAt:null });
          event(game.id, 'BOMB_DEFUSE_CANCELLED', { callsign:p.callsign, zone:zone.name }, p.id, 'WARNING');
          broadcastState(game.id); return;
        }
        clearTimeout(bombTimeouts.get(`${zone.id}:explode`));
        Object.assign(zone, { bombState:'DEFUSED', bombEndsAt:null, defuseStartedAt:null, defuseEndsAt:null });
        game.scores[defenderTeam] = (game.scores[defenderTeam] || 0) + 1;
        event(game.id, 'BOMB_DEFUSED', { callsign:p.callsign, team:p.team, zone:zone.name, score:game.scores[defenderTeam] }, p.id, 'WARNING');
        broadcastState(game.id);
      }, seconds * 1000));
      event(game.id, 'BOMB_DEFUSE_STARTED', { callsign:p.callsign, team:p.team, zone:zone.name, seconds }, p.id, 'CRITICAL');
      broadcastState(game.id); return res.json({ action:'BOMB_DEFUSE_STARTED', zone, seconds });
    }
    return res.status(403).json({ error: 'Twoja drużyna nie może wykonać tej akcji.' });
  }
  if (zone.type === 'FLAG') {
    if (p.carriedFlagId && zone.team === p.team) {
      const captured = game.zones.find(item => item.id === p.carriedFlagId);
      if (captured) { captured.carrierParticipantId = null; captured.completedAt = Date.now(); captured.completedByTeam = p.team; }
      p.carriedFlagId = null; game.scores[p.team] = (game.scores[p.team] || 0) + 1;
      event(game.id, 'FLAG_CAPTURED', { callsign: p.callsign, team: p.team, zone: captured?.name, score: game.scores[p.team] }, p.id, 'WARNING');
      broadcastState(game.id); return res.json({ action: 'FLAG_SCORED', zone, scores: game.scores });
    }
    if (zone.team === p.team) return res.status(409).json({ error: 'To flaga Twojej drużyny.' });
    if (zone.carrierParticipantId && zone.carrierParticipantId !== p.id) return res.status(409).json({ error: 'Ta flaga jest już przenoszona.' });
    zone.carrierParticipantId = p.id; zone.completedAt = null; zone.completedByTeam = null; p.carriedFlagId = zone.id;
    event(game.id, 'FLAG_TAKEN', { callsign: p.callsign, team: p.team, zone: zone.name }, p.id, 'WARNING');
    broadcastState(game.id); return res.json({ action: 'FLAG_TAKEN', zone });
  }
  if (['CONTROL','HILL'].includes(zone.type)) {
    if (zone.ownerTeam === p.team) return res.json({ action: 'ALREADY_CONTROLLED', zone });
    const seconds = Math.max(5, Number(game.modeSettings?.modeRules?.captureSeconds || 30));
    zone.capturingTeam = p.team; zone.captureStartedAt = Date.now(); zone.captureEndsAt = Date.now() + seconds * 1000;
    clearTimeout(zoneTimeouts.get(zone.id));
    zoneTimeouts.set(zone.id, setTimeout(() => {
      if (zone.capturingTeam !== p.team || zone.captureEndsAt > Date.now() + 500) return;
      zone.ownerTeam = p.team; zone.capturingTeam = null; zone.captureStartedAt = null; zone.captureEndsAt = null;
      game.scores[p.team] = (game.scores[p.team] || 0) + Number(game.modeSettings?.modeRules?.pointsPerCapture || 1);
      event(game.id, 'ZONE_CAPTURED', { callsign: p.callsign, team: p.team, zone: zone.name }, p.id, 'WARNING'); broadcastState(game.id);
    }, seconds * 1000));
    event(game.id, 'ZONE_CAPTURE_STARTED', { callsign: p.callsign, team: p.team, zone: zone.name, seconds }, p.id); broadcastState(game.id);
    return res.json({ action: 'CAPTURE_STARTED', zone });
  }
  if (zone.type === 'CHECKPOINT') {
    if (zone.team !== 'ALL' && zone.team !== p.team) return res.status(403).json({ error: 'Ten checkpoint należy do innej drużyny.' });
    const checkpoints = game.zones.filter(item => item.type === 'CHECKPOINT' && (item.team === 'ALL' || item.team === p.team)).sort((a,b) => (a.sequence || 999) - (b.sequence || 999));
    const next = checkpoints.find(item => item.completedByTeam !== p.team);
    if (next?.id !== zone.id) return res.status(409).json({ error: `Najpierw osiągnij checkpoint ${next?.sequence || 1}.` });
    const specialist=participantCapabilities(game,p).includes('CHECKPOINT_OPERATOR'),points=specialist?2:1;
    zone.completedByTeam = p.team; zone.completedAt = Date.now(); game.scores[p.team] = (game.scores[p.team] || 0) + points;
    event(game.id, 'CHECKPOINT_REACHED', { callsign: p.callsign, team: p.team, zone: zone.name, sequence: zone.sequence, specialist, points }, p.id); broadcastState(game.id);
    return res.json({ action: 'CHECKPOINT_COMPLETED', zone, completed: checkpoints.filter(item => item.completedByTeam === p.team).length, total: checkpoints.length });
  }
  if (zone.type==='EXTRACTION' && participantCapabilities(game,p).includes('EXTRACTION_TARGET')) {
    if (zone.team!=='ALL' && zone.team!==p.team) return res.status(403).json({ error:'Ta strefa ewakuacji należy do innej strony.' });
    if (zone.completedAt) return res.status(409).json({ error:'Ewakuacja w tej strefie została już wykonana.' });
    const points=game.mode==='VIP_ESCORT'?1:5;
    Object.assign(zone,{ completedByTeam:p.team, completedAt:Date.now() }); p.status='FINISHED'; game.scores[p.team]=(game.scores[p.team]||0)+points;
    event(game.id,'VIP_EXTRACTED',{ callsign:p.callsign, team:p.team, zone:zone.name },p.id,'WARNING'); broadcastState(game.id);
    return res.json({ action:'VIP_EXTRACTED', zone, scores:game.scores });
  }
  const objective = game.objectives?.find(item => item.id === zone.objectiveId || item.zoneId === zone.id);
  if (objective && (objective.team === 'ALL' || objective.team === p.team)) {
    if (objective.status==='COMPLETED') return res.status(409).json({ error:'Ten cel został już wykonany.' });
    const specialist=participantCapabilities(game,p).includes('OBJECTIVE_OPERATOR'),points=Math.round(objective.points*(specialist?1.25:1));
    objective.status = 'COMPLETED'; objective.progress = 100; game.scores[p.team] = (game.scores[p.team] || 0) + points;
    event(game.id, 'OBJECTIVE_COMPLETED', { callsign: p.callsign, team: p.team, objective: objective.name, specialist, points }, p.id); broadcastState(game.id);
    return res.json({ action: 'OBJECTIVE_COMPLETED', zone, objective, scores: game.scores });
  }
  return res.json({ action: 'ZONE_CONFIRMED', zone });
});
app.post('/api/games/:id/score', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const parsed = z.object({ team: z.enum(['SERE','OPFOR']), delta: z.number().int().min(-1000).max(1000) }).safeParse(req.body), game = store.games.get(req.params.id);
  if (!parsed.success || !game) return res.status(400).json({ error: 'Nieprawidłowa punktacja.' });
  if (req.auth.role === 'STAFF' && (!can(req.auth, 'MANAGE_OBJECTIVES') || req.auth.gameId !== game.id)) return res.status(403).json({ error: 'Brak uprawnienia do punktacji.' });
  game.scores[parsed.data.team] = Math.max(0, (game.scores[parsed.data.team] || 0) + parsed.data.delta); event(game.id, 'SCORE_CHANGED', { ...parsed.data, score: game.scores[parsed.data.team] }); broadcastState(game.id); res.json(game.scores);
});
app.patch('/api/participants/:id', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const parsed = participantUpdateSchema.safeParse(req.body);
  const participant = store.participants.get(req.params.id);
  const game = participant && store.games.get(participant.gameId);
  if (!parsed.success || !participant || !game) return res.status(400).json({ error: 'Nieprawidłowa zmiana uczestnika.' });
  if (req.auth.role === 'STAFF' && req.auth.gameId !== participant.gameId) return res.status(403).json({ error: 'Uczestnik należy do innej sesji.' });
  if (req.auth.role === 'STAFF' && ['team','role','squadId'].some(key => parsed.data[key] !== undefined) && !can(req.auth, 'MANAGE_TEAMS')) return res.status(403).json({ error: 'Brak uprawnienia do zespołów i ról.' });
  if (req.auth.role === 'STAFF' && ['status','hitCount','respawnRequired','mapAccess'].some(key => parsed.data[key] !== undefined) && !can(req.auth, 'MANAGE_PARTICIPANTS')) return res.status(403).json({ error: 'Brak uprawnienia do stanu uczestników.' });
  if (parsed.data.team && (game.state !== 'LOBBY' || !feature(game, 'allowTeamChanges'))) return res.status(409).json({ error: 'Zmiana drużyny jest wyłączona lub gra już się rozpoczęła.' });
  const nextSide=parsed.data.team||participant.team;
  const nextSquadId=parsed.data.squadId!==undefined?parsed.data.squadId:participant.squadId;
  const squad=nextSquadId ? game.teams?.find(team=>team.id===nextSquadId) : null;
  if (nextSquadId && (!squad || !squad.active || squad.side!==nextSide) && parsed.data.squadId!==undefined) return res.status(409).json({ error:'Wybrana drużyna operacyjna nie pasuje do strony uczestnika.' });
  if (parsed.data.team && participant.squadId && !game.teams?.some(team=>team.id===participant.squadId && team.side===parsed.data.team)) parsed.data.squadId=null;
  const nextRole=parsed.data.role||participant.role||'OPERATOR', role=game.roles?.find(item=>item.code===nextRole && item.active);
  if (!role) return res.status(409).json({ error:'Wybrana rola nie jest aktywna w tej sesji.' });
  const effectiveSquad=parsed.data.squadId===null?null:squad?.side===nextSide?squad:null;
  if (effectiveSquad?.allowedRoles?.length && !effectiveSquad.allowedRoles.includes(nextRole)) return res.status(409).json({ error:'Ta rola nie jest dozwolona w wybranej drużynie.' });
  if (effectiveSquad && parsed.data.squadId!==undefined && participant.squadId!==effectiveSquad.id && [...store.participants.values()].filter(item=>item.gameId===game.id&&item.squadId===effectiveSquad.id&&item.status!=='REMOVED').length>=effectiveSquad.maxPlayers) return res.status(409).json({ error:'Wybrana drużyna osiągnęła limit uczestników.' });
  Object.assign(participant, parsed.data);
  event(game.id, 'PARTICIPANT_CHANGED', { callsign: participant.callsign, ...parsed.data }, participant.id);
  broadcastState(game.id);
  res.json(participantView(participant));
});
app.post('/api/locations', auth, requireRole('PARTICIPANT'), (req, res) => {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nieprawidłowa lokalizacja.' });
  const p = store.participants.get(req.auth.participantId); const game = store.games.get(p?.gameId);
  if (!p || !game || game.state === 'FINISHED') return res.status(409).json({ error: 'Śledzenie zostało zakończone dla tej sesji.' });
  if (!feature(game, 'gpsTracking') || (game.state !== 'ACTIVE' && !feature(game, 'shareLocationInLobby'))) return res.status(409).json({ error: 'Udostępnianie lokalizacji jest wyłączone dla tej sesji.' });
  const previousLocation = p.location;
  const loc = { ...parsed.data, timestamp: parsed.data.timestamp || new Date().toISOString() };
  p.location = loc; p.lastSeenAt = new Date().toISOString(); p.battery = loc.battery ?? p.battery;
  if (feature(game, 'routeReplay')) {
    const lastPoint = store.tracks.at(-1), pointTime = Date.parse(loc.timestamp) || Date.now();
    const shouldRecord = !lastPoint || lastPoint.participantId !== p.id || pointTime - lastPoint.timestamp >= 5_000 || !previousLocation || distanceMeters(previousLocation.latitude, previousLocation.longitude, loc.latitude, loc.longitude) >= 3;
    if (shouldRecord) {
      store.tracks.push({ id: crypto.randomUUID(), gameId: game.id, participantId: p.id, callsign: p.callsign, team: p.team, role: p.role || 'OPERATOR', latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy ?? null, heading: loc.heading ?? null, timestamp: pointTime });
      if (store.tracks.length > 100_000) store.tracks.splice(0, store.tracks.length - 100_000);
    }
  }
  const outside = feature(game, 'geofence') && game.state === 'ACTIVE' && !pointInPolygon(loc.latitude, loc.longitude, game.boundary);
  if (outside !== Boolean(p.outside)) {
    p.outside = outside; p.status = outside ? 'OUTSIDE' : game.state === 'ACTIVE' ? 'ACTIVE' : 'READY';
    if (outside) p.boundaryCount += 1;
    event(game.id, outside ? 'BOUNDARY_EXIT' : 'BOUNDARY_RETURN', { callsign: p.callsign }, p.id, outside ? 'WARNING' : 'INFO');
  }
  broadcastState(game.id); res.status(202).json({ accepted: true, outside });
});
app.post('/api/participants/:id/assist', auth, requireRole('PARTICIPANT'), (req, res) => {
  const source=store.participants.get(req.auth.participantId), target=store.participants.get(req.params.id), game=store.games.get(source?.gameId);
  if (!source || !target || !game || source.gameId!==target.gameId || source.team!==target.team || source.id===target.id) return res.status(404).json({ error:'Nie znaleziono członka drużyny do pomocy.' });
  const capabilities=participantCapabilities(game,source),medic=feature(game,'medicSystem')&&capabilities.includes('REVIVE'),manager=capabilities.includes('RESPAWN_MANAGER');
  if (!medic&&!manager) return res.status(403).json({ error:'Rola uczestnika nie pozwala na przywrócenie gracza.' });
  if (game.state!=='ACTIVE' || !['CAPTURED','RESPAWN_WAIT','RESPAWN'].includes(target.status) && !target.respawnRequired) return res.status(409).json({ error:'Ten uczestnik nie wymaga obecnie pomocy.' });
  const range=manager?50:30;
  if (!source.location || !target.location || distanceMeters(source.location.latitude,source.location.longitude,target.location.latitude,target.location.longitude)>range) return res.status(409).json({ error:`Podejdź na odległość maksymalnie ${range} metrów.` });
  if (source.lastAssistAt && Date.now()-source.lastAssistAt<10_000) return res.status(429).json({ error:'Odczekaj chwilę przed kolejną pomocą.' });
  if (target.activeTimer) { const timer=store.timers.get(target.activeTimer); if(timer){timer.cancelledAt=Date.now();clearTimeout(timerTimeouts.get(timer.id));timerTimeouts.delete(timer.id);} target.activeTimer=null; }
  Object.assign(target,{ status:'ACTIVE', respawnRequired:false, hitCount:0 }); source.lastAssistAt=Date.now();
  event(game.id,manager?'RESPAWN_OVERRIDE':'PLAYER_REVIVED',{ operator:source.callsign, participant:target.callsign, squadId:source.squadId||null },target.id,'INFO'); broadcastState(game.id);
  res.json({ participant:participantView(target), medic:participantView(source) });
});
app.post('/api/hits', auth, requireRole('PARTICIPANT'), (req, res) => {
  const p = store.participants.get(req.auth.participantId), game = store.games.get(p?.gameId);
  if (!p || !game || game.state !== 'ACTIVE' || !feature(game, 'hitTracking')) return res.status(409).json({ error: 'Rejestrowanie trafień jest teraz wyłączone.' });
  if (p.respawnRequired || p.activeTimer) return res.status(409).json({ error: 'Najpierw zakończ bieżący respawn.' });
  p.hitCount = (p.hitCount || 0) + 1; const threshold = game.modeSettings?.hitsToRespawn || 1;
  if (p.hitCount >= threshold) { p.respawnRequired = true; p.status = 'RESPAWN_WAIT'; event(game.id, 'RESPAWN_REQUIRED', { callsign: p.callsign, hits: p.hitCount }, p.id, 'WARNING'); }
  else event(game.id, 'HIT_RECORDED', { callsign: p.callsign, hits: p.hitCount, threshold }, p.id, 'INFO');
  broadcastState(game.id); res.status(201).json({ participant: participantView(p), threshold, respawnRequired: p.respawnRequired });
});
app.post('/api/timers', auth, requireRole('PARTICIPANT'), (req, res) => {
  const p = store.participants.get(req.auth.participantId); const game = store.games.get(p?.gameId);
  if (!p || !game || !feature(game, 'timers') || game.state !== 'ACTIVE' || p.activeTimer) return res.status(409).json({ error: 'Timer nie może być teraz uruchomiony.' });
  if (p.respawnRequired && feature(game, 'respawnZones') && !inRespawnZone(game, p)) return res.status(409).json({ error: 'Wejdź do strefy respawnu swojej drużyny.' });
  const seconds = p.respawnRequired ? participantRespawnSeconds(game,p) : p.team === 'SERE' ? game.sereTimerSeconds : game.opforTimerSeconds;
  const kind = p.respawnRequired ? 'RESPAWN' : p.team === 'SERE' ? 'SERE' : 'OPFOR';
  const timer = { id: crypto.randomUUID(), gameId: game.id, participantId: p.id, kind, seconds, startedAt: Date.now(), endsAt: Date.now() + seconds * 1000 };
  store.timers.set(timer.id, timer); p.activeTimer = timer.id; p.timerCount += 1; p.status = p.respawnRequired ? 'RESPAWN' : p.team === 'SERE' ? 'TIMER' : 'RESPAWN';
  event(game.id, 'TIMER_STARTED', { callsign: p.callsign, seconds }, p.id); broadcastState(game.id);
  scheduleTimer(timer);
  res.status(201).json(timer);
});
app.post('/api/sos', auth, requireRole('PARTICIPANT'), (req, res) => {
  const p = store.participants.get(req.auth.participantId); const game = store.games.get(p?.gameId);
  if (!p || !game || !feature(game, 'sos') || game.state === 'FINISHED') return res.status(409).json({ error: 'SOS jest wyłączony lub sesja została zakończona.' });
  const alert = { id: crypto.randomUUID(), gameId: game.id, participantId: p.id, callsign: p.callsign, team: p.team, status: 'ACTIVE', location: p.location, activatedAt: new Date().toISOString() };
  store.sos.set(alert.id, alert); p.activeSos = true; p.status = 'SOS';
  event(game.id, 'SOS_ACTIVATED', { callsign: p.callsign, location: p.location }, p.id, 'CRITICAL');
  io.to(`game:${game.id}`).emit('sos:changed', alert); broadcastState(game.id); res.status(201).json(alert);
});
app.patch('/api/sos/:id', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  if (req.auth.role === 'STAFF' && !can(req.auth, 'ACK_SOS')) return res.status(403).json({ error: 'Brak uprawnienia do obsługi SOS.' });
  const status = z.enum(['ACKNOWLEDGED','RESOLVED','FALSE_ALARM']).safeParse(req.body?.status);
  const alert = store.sos.get(req.params.id);
  if (!status.success || !alert) return res.status(400).json({ error: 'Nieprawidłowy alarm lub status.' });
  alert.status = status.data; alert.updatedAt = new Date().toISOString();
  const p = store.participants.get(alert.participantId);
  if (status.data !== 'ACKNOWLEDGED' && p) { p.activeSos = false; p.status = 'ACTIVE'; }
  event(alert.gameId, `SOS_${status.data}`, { callsign: alert.callsign }, alert.participantId, status.data === 'ACKNOWLEDGED' ? 'WARNING' : 'INFO');
  io.to(`game:${alert.gameId}`).emit('sos:changed', alert); broadcastState(alert.gameId); res.json(alert);
});
app.post('/api/messages', auth, requireRole('ADMIN','STAFF','PARTICIPANT'), (req, res) => {
  const parsed = z.object({ gameId: z.string().uuid().optional(), audience: z.enum(['ALL','SERE','OPFOR','STAFF','PARTICIPANT']), body: z.string().trim().min(1).max(500), recipientStaffId: z.string().uuid().optional(), recipientParticipantId: z.string().uuid().optional() }).safeParse(req.body);
  const viewer = effectiveViewer(req.auth), gameId = viewer.gameId || parsed.data?.gameId, game = store.games.get(gameId);
  if (!parsed.success || !game) return res.status(400).json({ error: 'Nieprawidłowy komunikat.' });
  const participantSender=viewer.role==='PARTICIPANT'?store.participants.get(viewer.participantId):null;
  const teamBroadcast=Boolean(participantSender && feature(game,'commanderBroadcast') && participantCapabilities(game,participantSender).includes('COMMAND') && parsed.data.audience===participantSender.team);
  if (viewer.role === 'PARTICIPANT' && (!feature(game, 'playerMessaging') || !teamBroadcast && (parsed.data.audience !== 'STAFF' || !parsed.data.recipientStaffId))) return res.status(403).json({ error: 'Ta rola nie może wysłać tego rodzaju komunikatu.' });
  if (viewer.role === 'PARTICIPANT') {
    if (!teamBroadcast) {
      const recipient = store.staff.get(parsed.data.recipientStaffId);
      if (!recipient || recipient.gameId !== gameId || !recipient.active || !recipient.permissions.includes('RECEIVE_PLAYER_MESSAGES')) return res.status(404).json({ error: 'Ten odbiorca nie jest już dostępny.' });
    }
  }
  if (viewer.role === 'STAFF') {
    const allowed = parsed.data.audience === 'ALL' ? can(viewer, 'SEND_ALL_MESSAGES') : ['SERE','OPFOR'].includes(parsed.data.audience) ? can(viewer, 'SEND_TEAM_MESSAGES') : can(viewer, 'SEND_DIRECT_MESSAGES');
    if (!allowed) return res.status(403).json({ error: 'Konto nie ma uprawnienia do tego rodzaju wiadomości.' });
    if (parsed.data.audience === 'PARTICIPANT' && !store.participants.has(parsed.data.recipientParticipantId)) return res.status(404).json({ error: 'Nie znaleziono odbiorcy.' });
  }
  const message = { id: crypto.randomUUID(), gameId, ...parsed.data, senderRole: viewer.role, senderName: viewer.callsign || 'GRACZ', senderStaffId: viewer.staffId || null, senderParticipantId: viewer.participantId || null, time: Date.now(), createdAt: new Date().toISOString() };
  store.messages.push(message); event(gameId, 'MESSAGE_SENT', { audience: message.audience, sender: message.senderName });
  broadcastMessage(gameId, message); broadcastState(gameId); res.status(201).json(message);
});
app.post('/api/games/:id/:action(start|pause|resume|finish|reset)', auth, requireRole('ADMIN','STAFF'), (req, res) => {
  const game = store.games.get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Nie znaleziono gry.' });
  if (req.auth.role === 'STAFF' && (req.auth.gameId !== game.id || !can(req.auth, 'MANAGE_GAME_STATE') || req.params.action === 'reset')) return res.status(403).json({ error: 'Brak uprawnienia do zmiany stanu gry.' });
  if (req.params.action === 'reset') {
    if (feature(game,'autoSessionArchive') && [...store.participants.values()].some(item=>item.gameId===game.id)) createArchive(game,`${game.code} · przed resetem`,true);
    for (const [id, participant] of store.participants) if (participant.gameId === game.id) store.participants.delete(id);
    for (const [id, timer] of store.timers) if (timer.gameId === game.id) { clearTimeout(timerTimeouts.get(id)); timerTimeouts.delete(id); store.timers.delete(id); }
    for (const [id, alert] of store.sos) if (alert.gameId === game.id) store.sos.delete(id);
    for (const zone of game.zones || []) {
      clearTimeout(zoneTimeouts.get(zone.id)); zoneTimeouts.delete(zone.id);
      for (const suffix of ['plant','explode','defuse']) { clearTimeout(bombTimeouts.get(`${zone.id}:${suffix}`)); bombTimeouts.delete(`${zone.id}:${suffix}`); }
      Object.assign(zone, { ownerTeam:null, carrierParticipantId:null, capturingTeam:null, captureStartedAt:null, captureEndsAt:null, completedByTeam:null, completedAt:null, bombState:'IDLE', plantedByParticipantId:null, defusedByParticipantId:null, plantStartedAt:null, plantEndsAt:null, bombPlantedAt:null, bombEndsAt:null, defuseStartedAt:null, defuseEndsAt:null });
    }
    store.events = store.events.filter(item => item.gameId !== game.id);
    store.messages = store.messages.filter(item => item.gameId !== game.id);
    store.tracks = store.tracks.filter(item => item.gameId !== game.id);
    Object.assign(game, { state: 'LOBBY', startedAt: null, pausedAt: null, finishedAt: null, scores: { SERE: 0, OPFOR: 0 } });
    event(game.id, 'GAME_RESET', {});
    io.to(`game:${game.id}`).emit('game:changed', game); broadcastState(game.id); return res.json(game);
  }
  const previousState=game.state;
  const next = { start: 'ACTIVE', pause: 'PAUSED', resume: 'ACTIVE', finish: 'FINISHED' }[req.params.action];
  game.state = next; game[`${req.params.action === 'finish' ? 'finished' : req.params.action === 'start' ? 'started' : req.params.action}At`] = new Date().toISOString();
  if (req.params.action === 'start' || req.params.action === 'resume') {
    for (const p of store.participants.values()) if (p.gameId === game.id && !p.activeSos) p.status = 'ACTIVE';
  }
  if (req.params.action === 'finish') {
    for (const p of store.participants.values()) if (p.gameId === game.id) p.status = 'FINISHED';
    if (previousState!=='FINISHED' && feature(game,'autoSessionArchive')) createArchive(game,`${game.code} · zakończenie`,true);
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
function broadcastMessage(gameId, message) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.gameId === gameId && messageVisibleTo(message, socket.auth)) socket.emit('message:new', message);
  }
}

io.use((socket, next) => { try { socket.auth = jwt.verify(socket.handshake.auth?.token, JWT_SECRET); next(); } catch { next(new Error('unauthorized')); } });
io.on('connection', socket => {
  const a = effectiveViewer(socket.auth); const gameId = a.gameId || socket.handshake.auth?.gameId || demoGame.id;
  if (!store.games.has(gameId)) return socket.disconnect(true);
  socket.data.gameId = gameId;
  socket.join(`game:${gameId}`);
  if (['ADMIN','STAFF'].includes(a.role)) socket.join(`game:${gameId}:staff`);
  if (a.team) socket.join(`game:${gameId}:team:${a.team}`);
  socket.emit('state:snapshot', snapshot(gameId, a));
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
server.listen(PORT, () => console.log(`Fieldmaster listening on http://localhost:${PORT}`));
