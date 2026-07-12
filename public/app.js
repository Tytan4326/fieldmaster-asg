import { distanceMeters, latLonToUtm, mgrs, pointInPolygon, utmToLatLon } from './geo.js?v=1';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const now = () => new Date().toISOString();
const params = new URLSearchParams(location.search);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('fieldmaster-demo') : null;
const backend = { available:false, connected:false, socket:null, token:null, gameId:null, required:params.get('demo')!=='1' };
const center = { lat: 52.2304, lon: 21.0184 };
const polygon = [[52.2280,21.0060],[52.2357,21.0092],[52.2380,21.0220],[52.2332,21.0310],[52.2248,21.0250],[52.2228,21.0140]];
const FEATURE_DEFS = [
  ['gpsTracking','Śledzenie GPS','Pozycje uczestników są przesyłane na mapę.',true],
  ['geofence','Alarm granicy','Wykrywa wyjście poza obszar gry.',true],
  ['sos','Alarm SOS','Udostępnia przycisk ratunkowy i obsługę alarmów.',true],
  ['timers','Timery SERE / OPFOR','Pozwala uczestnikom uruchamiać timery.',true],
  ['allowTeamChanges','Zmiana drużyn','Administrator może zmieniać strony przed startem.',true],
  ['allowJoining','Dołączanie uczestników','Pozwala nowym osobom wejść do lobby.',true],
  ['satelliteDefault','Satelita domyślnie','Uruchamia mapę od widoku satelitarnego.',true],
  ['mgrsGrid','Siatka UTM/MGRS','Rysuje wojskową siatkę współrzędnych.',true],
  ['shareLocationInLobby','GPS przed startem','Pokazuje pozycje już w poczekalni.',true],
  ['opforTeamMap','Mapa zespołu OPFOR','OPFOR widzi pozycje członków swojej strony.',true],
  ['audioAlarms','Alarmy dźwiękowe','Odtwarza dźwięki timerów, SOS i granicy.',false],
  ['vibration','Wibracje','Uruchamia wibracje alarmowe na telefonach.',false],
  ['boundaryReminders','Przypomnienia granicy','Powtarza alarm poza obszarem co 30 sekund.',false],
  ['pwaInstall','Instalacja aplikacji','Pokazuje przycisk instalacji PWA.',false],
  ['adminMessages','Komunikaty administratora','Pozwala wysyłać wiadomości do zespołów.',false],
  ['csvExport','Eksport CSV','Pozwala pobrać raport sesji.',false],
  ['showBattery','Stan baterii','Pokazuje administratorowi poziom baterii.',false],
  ['showAccuracy','Dokładność GPS','Pokazuje dokładność pozycji na mapie.',false],
  ['gpsFallback','Awaryjny tryb GPS','Przełącza na mniej dokładny tryb po błędzie.',false],
  ['offlineQueue','Kolejka offline','Przechowuje lokalne zdarzenia do powrotu sieci.',false]
];
const DEFAULT_FEATURES = Object.fromEntries(FEATURE_DEFS.map(([key])=>[key,true]));
const enabled = key => state?.game?.features?.[key] ?? DEFAULT_FEATURES[key] ?? true;

const icons = {
  shield:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3 20 7v6c0 4.4-3 7.1-8 8.7C7 20.1 4 17.4 4 13V7z"/><circle cx="12" cy="12" r="3"/><path d="M12 6v3m0 6v3M6 12h3m6 0h3"/></svg>`,
  play:'▶', pause:'Ⅱ', stop:'■', alert:'⚠', timer:'◷', map:'⌖', users:'♟', message:'✦', sos:'✚'
};

function initialState() {
  const t = Date.now();
  return {
    version: 2,
    game: { id:'game-demo', code:'WILK24', name:'Operacja Nocny Wilk', state:'LOBBY', durationMinutes:1440, startedAt:null, pausedAt:null, sereSeconds:20, opforSeconds:60, boundary:polygon, features:{...DEFAULT_FEATURES} },
    participants: [
      {id:'p-raven',callsign:'RAVEN',team:'SERE',status:'READY',x:40,y:38,lat:52.2331,lon:21.0172,battery:82,lastSeen:t-12000,timerCount:0,boundaryCount:0,distance:6.8},
      {id:'p-ghost',callsign:'GHOST',team:'SERE',status:'READY',x:63,y:64,lat:52.2274,lon:21.0238,battery:64,lastSeen:t-24000,timerCount:1,boundaryCount:0,distance:8.2},
      {id:'p-viper',callsign:'VIPER',team:'OPFOR',status:'READY',x:54,y:30,lat:52.2349,lon:21.0210,battery:91,lastSeen:t-6000,timerCount:0,boundaryCount:0,distance:10.3},
      {id:'p-havoc',callsign:'HAVOC',team:'OPFOR',status:'READY',x:27,y:65,lat:52.2272,lon:21.0124,battery:47,lastSeen:t-68000,timerCount:2,boundaryCount:1,distance:9.7}
    ],
    events: [
      ev('SESSION_CREATED','GAME-MASTER utworzył sesję',null,'INFO',t-45*60000),
      ev('PARTICIPANT_JOINED','HAVOC dołączył do OPFOR','p-havoc','INFO',t-31*60000),
      ev('BOUNDARY_RETURN','HAVOC powrócił na teren gry','p-havoc','INFO',t-8*60000)
    ],
    sos: [], messages: [], offlineQueue: []
  };
}
function ev(type, text, participantId=null, severity='INFO', time=Date.now()) { return {id:uid(),type,text,participantId,severity,time}; }

let state;
try { state = JSON.parse(localStorage.getItem('fieldmaster-state')) || initialState(); }
catch { state = initialState(); }
if (state.version !== 2) state = initialState();

let ui = { view: params.get('view') || 'join', adminTab:'dashboard', playerTab:'status', joinStep:1, joining:false, team:null, callsign:'', sessionCode:params.get('code')||state.game.code, adminGames:[], consent:false, rules:false, locationConsent:false, installPrompt:null, installed:window.matchMedia?.('(display-mode: standalone)').matches||window.navigator.standalone===true, gpsStatus:'NOT_TESTED', gpsAccuracy:null, gpsMessage:'', testLocation:null, boundaryDraft:null };
let timerInterval = null, geoWatch = null, audioCtx = null, lastBeep = 0, boundaryAlarmTimer = null;
let gpsFallback = false, gpsRestartTimer = null, gpsErrorShownAt = 0, gpsSendInFlight = false, lastLocationSent = null, batteryLevel = null;
let mapSerial = 0;
let renderGeneration = 0;
let mapLibraryRetries = 0;
const mapContexts = new Map();
const activeMaps = [];
const mapViewState = new Map();

function save(announce=true) {
  localStorage.setItem('fieldmaster-state', JSON.stringify(state));
  if (announce && !backend.available) channel?.postMessage({ type:'state', state });
}
channel?.addEventListener('message', e => { if (!backend.available && e.data?.type === 'state') { state = e.data.state; render(); checkCritical(); } });
window.addEventListener('storage', e => { if (e.key === 'fieldmaster-state' && e.newValue) { state=JSON.parse(e.newValue); render(); } });
window.addEventListener('online', () => { toast('Połączenie przywrócone','Synchronizuję oczekujące zdarzenia.'); syncQueue(); render(); });
window.addEventListener('offline', () => { toast('Brak połączenia','Zdarzenia są zapisywane lokalnie. SOS może nie dotrzeć!', 'critical'); render(); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); ui.installPrompt=e; render(); });
window.addEventListener('appinstalled',()=>{ui.installed=true;ui.installPrompt=null;toast('Aplikacja zainstalowana','Fieldmaster jest dostępny z ekranu głównego.');render();});

function addEvent(type, text, participantId=null, severity='INFO') {
  const item = ev(type,text,participantId,severity); state.events.unshift(item);
  if (!navigator.onLine && enabled('offlineQueue')) state.offlineQueue.push(item);
  save(); return item;
}
function syncQueue(){ if(!navigator.onLine || !state.offlineQueue.length) return; const count=state.offlineQueue.length; state.offlineQueue=[]; save(); toast('Synchronizacja zakończona',`${count} zdarzeń wysłano do serwera.`); }
async function api(path, options={}, token=backend.token){
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{}) ,...(options.headers||{})}});
  let body={};try{body=await response.json();}catch{}
  if(!response.ok)throw new Error(body.error||`Błąd serwera (${response.status})`);
  return body;
}
function normalizeGame(game){if(!game)return state.game;return{...state.game,...game,features:{...DEFAULT_FEATURES,...(state.game?.features||{}),...(game.features||{})},sereSeconds:game.sereTimerSeconds??game.sereSeconds??state.game.sereSeconds,opforSeconds:game.opforTimerSeconds??game.opforSeconds??state.game.opforSeconds,startedAt:game.startedAt?new Date(game.startedAt).getTime():null,finishedAt:game.finishedAt?new Date(game.finishedAt).getTime():null};}
function normalizeParticipant(p){const hasLocation=Boolean(p.location||p.hasLocation);const lat=p.location?.latitude??p.lat??center.lat,lon=p.location?.longitude??p.lon??center.lon;return{...p,lat,lon,hasLocation,accuracy:p.location?.accuracy??p.accuracy??null,lastSeen:p.lastSeenAt?new Date(p.lastSeenAt).getTime():p.lastSeen??Date.now(),timerEnd:p.timerEnd?Number(p.timerEnd):null,timerCount:p.timerCount??0,boundaryCount:p.boundaryCount??0,distance:p.distance??0,battery:p.battery??null};}
function normalizeAlert(s){const lat=s.location?.latitude??s.lat??center.lat,lon=s.location?.longitude??s.lon??center.lon;return{...s,lat,lon,time:s.activatedAt?new Date(s.activatedAt).getTime():s.time??Date.now()};}
function serverEventText(e){const c=e.details?.callsign||'';const labels={PARTICIPANT_JOINED:`${c} dołączył do gry`,PARTICIPANT_CHANGED:`Zmieniono ustawienia uczestnika ${c}`,GAME_SETTINGS_CHANGED:'Administrator zmienił ustawienia gry',GAME_ACTIVE:'Gra została rozpoczęta',GAME_PAUSED:'Gra została wstrzymana',GAME_FINISHED:'Gra została zakończona',TIMER_STARTED:`${c} uruchomił timer`,TIMER_FINISHED:`${c} zakończył timer`,SOS_ACTIVATED:`SOS — ${c} potrzebuje pomocy`,SOS_ACKNOWLEDGED:`${c}: alarm przyjęty`,SOS_RESOLVED:`${c}: alarm rozwiązany`,SOS_FALSE_ALARM:`${c}: fałszywy alarm`,BOUNDARY_EXIT:`${c} opuścił teren gry`,BOUNDARY_RETURN:`${c} wrócił na teren gry`,ADMIN_MESSAGE:'Wysłano komunikat administratora'};return labels[e.type]||e.type.replaceAll('_',' ').toLowerCase();}
function stateUiSignature(){return JSON.stringify({game:[state.game.id,state.game.code,state.game.state,state.game.name,state.game.durationMinutes,state.game.sereSeconds,state.game.opforSeconds,state.game.startedAt,state.game.finishedAt,state.game.boundary,state.game.features],participants:state.participants.map(p=>[p.id,p.team,p.status,Boolean(p.outside),Boolean(p.activeSos),p.timerEnd,p.boundaryCount]),sos:state.sos.map(s=>[s.id,s.status]),eventCount:state.events.length});}
function assignSnapshot(data){state.game=normalizeGame(data.game);state.participants=(data.participants||[]).map(normalizeParticipant);if(data.sos)state.sos=data.sos.map(normalizeAlert);if(Array.isArray(data.events))state.events=data.events.map(e=>({id:e.id,type:e.type,text:serverEventText(e),participantId:e.participantId,severity:e.severity,time:new Date(e.createdAt).getTime()}));}
function applySnapshot(data){
  const before=stateUiSignature();
  const previousState=state.game.state,previousGameId=state.game.id;
  assignSnapshot(data);
  if(previousGameId===state.game.id&&previousState!=='ACTIVE'&&state.game.state==='ACTIVE')resetGameMapViews(state.game.id);
  save(false);
  if(before===stateUiSignature()){updateActiveMaps();updateLiveLocationDom();return;}
  render();checkCritical();
}
function connectRealtime(token,gameId){
  if(!backend.available||!window.io||!token)return;
  backend.token=token;backend.gameId=gameId||backend.gameId||state.game.id;
  backend.socket?.disconnect();
  const socket=window.io({auth:{token,gameId:backend.gameId}});backend.socket=socket;
  socket.on('connect',()=>{backend.connected=true;render();});
  socket.on('disconnect',()=>{backend.connected=false;render();});
  socket.on('connect_error',error=>{backend.connected=false;if(String(error?.message).includes('unauthorized'))handleUnauthorized();else if(Date.now()-gpsErrorShownAt>15000){gpsErrorShownAt=Date.now();toast('Brak połączenia realtime','Aplikacja spróbuje połączyć się ponownie.','warning');}});
  socket.on('state:snapshot',applySnapshot);
  socket.on('game:changed',game=>{const was=state.game.state;state.game=normalizeGame(game);if(was!=='ACTIVE'&&state.game.state==='ACTIVE')resetGameMapViews(state.game.id);save(false);render();});
  socket.on('sos:changed',raw=>{const alert=normalizeAlert(raw),i=state.sos.findIndex(s=>s.id===alert.id);if(i>=0)state.sos[i]=alert;else state.sos.unshift(alert);save(false);render();checkCritical();});
  socket.on('message:new',message=>{state.messages.unshift(message);save(false);toast('Nowy komunikat',message.body);beep(720,.12);render();});
}
async function detectBackend(){
  try{const health=await api('/api/health',{},null);backend.available=Boolean(health.ok);try{const pub=await api(`/api/games/${encodeURIComponent(ui.sessionCode||state.game.code)}/public`,{},null);state.game=normalizeGame(pub);ui.sessionCode=state.game.code;}catch{}}catch{backend.available=false;}
}
function toast(title, message='', tone='') {
  const item=document.createElement('div'); item.className=`toast ${tone}`; item.innerHTML=`<strong>${esc(title)}</strong><p>${esc(message)}</p>`;
  $('#toast-region').append(item); setTimeout(()=>item.remove(),5000);
}
function esc(value=''){ const e=document.createElement('span'); e.textContent=String(value); return e.innerHTML; }
function fmtTime(value){ return new Date(value).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'}); }
function ago(value){ const s=Math.max(0,Math.floor((Date.now()-Number(value))/1000)); return s<10?'teraz':s<60?`${s} s`:s<3600?`${Math.floor(s/60)} min`:`${Math.floor(s/3600)} h`; }
function clock(seconds){ const s=Math.max(0,Math.ceil(seconds)); return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
function durationClock(seconds){ const s=Math.max(0,Math.ceil(seconds));return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
function statusLabel(s){ return ({LOBBY:'OCZEKIWANIE',ACTIVE:'AKTYWNA',PAUSED:'WSTRZYMANA',FINISHED:'ZAKOŃCZONA',READY:'GOTOWY',TIMER:'ZATRZYMANIE',RESPAWN:'RESPAWN',OUTSIDE:'POZA TERENEM',SOS:'SOS',DISCONNECTED:'ROZŁĄCZONY'})[s]||s; }
function coordToXY(lat,lon){ return { x:Math.max(4,Math.min(96,14+(lon-21.006)/(21.031-21.006)*70)), y:Math.max(5,Math.min(95,13+(52.238-lat)/(52.238-52.2228)*72)) }; }

function rememberMapView(controller){try{const c=controller.map.getCenter();mapViewState.set(controller.context.viewKey,{lat:c.lat,lon:c.lng,zoom:controller.map.getZoom()});}catch{}}
function destroyMaps(){while(activeMaps.length){const controller=activeMaps.pop();try{controller.map.stop?.();rememberMapView(controller);controller.map.remove();}catch{}}mapContexts.clear();}
function resetGameMapViews(gameId=state.game.id){for(const key of [...mapViewState.keys()])if(key.startsWith(`${gameId}:`))mapViewState.delete(key);}
function render(){
  const generation=++renderGeneration;
  stopTimerTicker();
  destroyMaps();
  if(ui.view==='admin') renderAdmin(); else if(ui.view==='player') renderPlayer(); else renderJoin();
  bindGlobal();
  requestAnimationFrame(()=>{if(generation===renderGeneration)initMaps();});
}
function brand(){ return `<div class="brand"><div class="brand-mark">${icons.shield}</div><div><div class="brand-name">FIELDMASTER</div><div class="brand-sub">TACTICAL TRAINING SYSTEM</div></div></div>`; }
function installButton(className='btn btn-sm btn-ghost'){return enabled('pwaInstall')?`<button class="${className}" data-action="install" ${ui.installed?'disabled':''}>${ui.installed?'✓ Zainstalowana':'↓ Zainstaluj aplikację'}</button>`:'';}
function connection(){ const online=navigator.onLine&&(!backend.available||backend.connected);return `<div class="connection"><i class="dot ${online?'':'offline'}"></i>${online?(backend.available?'SERWER ONLINE':'TRYB LOKALNY'):`OFFLINE · ${state.offlineQueue.length} W KOLEJCE`}</div>`; }

function renderJoin(){
  const locked=params.get('team'); if(locked) ui.team=locked;
  $('#app').innerHTML=`<main class="join-shell"><section class="join-form-side"><div class="join-brand-row">${brand()}${installButton()}</div><div class="join-form">
    <div class="eyebrow">Sesja ${esc(state.game.code)} · ${statusLabel(state.game.state)}</div>
    <h1>${ui.joinStep===1?'Dołącz do operacji':ui.joinStep===2?'Wybierz stronę':ui.joinStep===3?'Bezpieczeństwo':'Test gotowości'}</h1>
    <p class="lead">${joinLead()}</p><div class="stepper">${[1,2,3,4].map(n=>`<i class="step ${n===ui.joinStep?'active':n<ui.joinStep?'done':''}"></i>`).join('')}</div>
    ${joinStep()}<div class="input-row" style="margin-top:20px">${ui.joinStep>1?`<button class="btn btn-ghost" data-action="join-back" ${ui.joining?'disabled':''}>Wstecz</button>`:''}<button class="btn btn-primary" style="flex:1" data-action="join-next" ${ui.joining?'disabled':''}>${ui.joining?'Łączenie z serwerem…':ui.joinStep===4?'Potwierdzam gotowość':'Dalej'}</button></div>
  </div><div class="hint">SOS nie zastępuje numeru 112 ani kanału ratunkowego organizatora. Udział możesz zakończyć w każdej chwili.</div></section>
  <aside class="join-visual"><div class="visual-copy"><div class="visual-number">24H</div><h2>Każda pozycja. Jedna prawda.</h2><p>Cyfrowy mistrz gry synchronizuje bezpieczeństwo, statusy i przebieg operacji bez ujawniania danych taktycznych przeciwnikowi.</p><div class="safety-note"><b>◎</b><span>Lokalizacja jest jawna, aktywna tylko podczas sesji i widoczna zgodnie z rolą. Alarm SOS ujawnia pozycję wszystkim ze względów bezpieczeństwa.</span></div></div></aside></main>`;
}
function joinLead(){ return ['','Wpisz kryptonim używany podczas całego szkolenia. Musi być unikalny w tej sesji.','Stronę możesz wybrać przed dołączeniem, a organizator może ją zmienić do rozpoczęcia gry.','Przeczytaj i zaakceptuj warunki. Bez zgody GPS nie uruchomimy śledzenia.','Sprawdzimy połączenie, GPS i dźwięk. Test SOS nie wysyła prawdziwego alarmu.'][ui.joinStep]; }
function joinStep(){
  if(ui.joinStep===1) return `<div class="field"><label class="label" for="callsign">KRYPTONIM</label><input class="input" id="callsign" maxlength="24" autocomplete="nickname" value="${esc(ui.callsign)}" placeholder="np. RAVEN"></div><div class="field"><label class="label" for="session-code">KOD SESJI</label><input class="input" id="session-code" maxlength="16" autocomplete="off" value="${esc(ui.sessionCode||state.game.code)}" placeholder="np. WILK24"><div class="hint">Kod otrzymasz od organizatora. Wielkość liter nie ma znaczenia.</div></div>`;
  if(ui.joinStep===2) return `<div class="team-choice"><button class="team-option sere ${ui.team==='SERE'?'selected':''}" data-team="SERE"><span class="eyebrow">UKRYWAJĄCY</span><strong>SERE</strong><small>Ograniczony interfejs, brak pozycji przeciwnika, zatrzymanie 20 s.</small></button><button class="team-option opfor ${ui.team==='OPFOR'?'selected':''}" data-team="OPFOR"><span class="eyebrow" style="color:var(--orange)">POŚCIGOWI</span><strong>OPFOR</strong><small>Mapa własnej drużyny, brak pozycji SERE, respawn 60 s.</small></button></div>`;
  if(ui.joinStep===3) return `<label class="consent"><input type="checkbox" data-consent="consent" ${ui.consent?'checked':''}><span>Wyrażam dobrowolną zgodę na udział i udostępnianie lokalizacji organizatorowi od dołączenia do zakończenia sesji.</span></label><label class="consent"><input type="checkbox" data-consent="rules" ${ui.rules?'checked':''}><span>Akceptuję zasady bezpieczeństwa, granice terenu i prawo do przerwania udziału.</span></label><label class="consent"><input type="checkbox" data-consent="locationConsent" ${ui.locationConsent?'checked':''}><span>Rozumiem, że SOS ujawni moją lokalizację wszystkim uczestnikom oraz organizatorowi.</span></label>`;
  const gpsTone=ui.gpsStatus==='OK'?'':ui.gpsStatus==='ERROR'?'warning':'';
  const gpsText=ui.gpsStatus==='OK'?`GPS działa · dokładność ±${Math.round(ui.gpsAccuracy||0)} m`:ui.gpsStatus==='CHECKING'?'Łączenie z GPS…':ui.gpsStatus==='ERROR'?(ui.gpsMessage||'GPS niedostępny — sprawdź uprawnienia'):'GPS nie został jeszcze sprawdzony';
  return `<div class="panel"><div class="roster-card"><div class="team-badge ${ui.team?.toLowerCase()}">${ui.team==='SERE'?'SR':'OP'}</div><div><div class="callsign">${esc(ui.callsign)}</div><div class="roster-meta">${ui.team} · ${state.game.name}</div></div><span class="status-pill">GOTOWY</span></div><div style="padding:14px"><div class="status-banner ${backend.available?'':'warning'}"><span>●</span><div>Połączenie z serwerem <small style="display:block;color:var(--muted);margin-top:3px">${backend.available?'Dostępne':navigator.onLine?'Serwer chwilowo niedostępny':'Brak internetu'}</small></div></div><div class="status-banner ${gpsTone}"><span>⌖</span><div>${gpsText}<small style="display:block;color:var(--muted);margin-top:3px">Po dołączeniu pozycja będzie widoczna dla organizatora.</small></div></div><div class="input-row"><button class="btn btn-ghost" style="flex:1" data-action="test-gps">Sprawdź GPS</button><button class="btn btn-ghost" style="flex:1" data-action="test-sound">Test dźwięku</button></div></div></div>`;
}

function renderAdmin(){
  if(sessionStorage.getItem('fm-admin')!=='ok'){ renderAdminLogin(); return; }
  const counts={sere:state.participants.filter(p=>p.team==='SERE').length,opfor:state.participants.filter(p=>p.team==='OPFOR').length,sos:state.sos.filter(s=>['ACTIVE','ACKNOWLEDGED'].includes(s.status)).length,timers:state.participants.filter(p=>p.timerEnd>Date.now()).length,outside:state.participants.filter(p=>p.outside).length};
  const elapsed=state.game.startedAt?(state.game.finishedAt||Date.now())-state.game.startedAt:0; const remaining=Math.max(0,state.game.durationMinutes*60000-elapsed);
  $('#app').innerHTML=`<div class="shell"><header class="topbar">${brand()}<nav class="nav">${['dashboard:Dowodzenie','map:Mapa live','participants:Uczestnicy','events:Historia','report:Raport','settings:Ustawienia'].map(x=>{const[k,l]=x.split(':');return`<button class="${ui.adminTab===k?'active':''}" data-tab="${k}">${l}</button>`}).join('')}</nav><div class="top-actions">${adminSessionSelect()}${connection()}${installButton()}<div class="avatar">GM</div></div></header>
  <main class="admin-main"><div class="command-strip"><div class="mission-title"><h1>${esc(state.game.name)}</h1><div class="mission-meta"><span class="chip ${state.game.state==='ACTIVE'?'chip-live':state.game.state==='PAUSED'?'chip-paused':'chip-lobby'}">● ${statusLabel(state.game.state)}</span><span>KOD ${state.game.code}</span><span>•</span><span>${new Date().toLocaleDateString('pl-PL')}</span></div></div><div class="mission-actions">${gameActions()}</div></div>
  <section class="stats"><article class="stat"><div class="stat-label">CZAS DO KOŃCA <span>◷</span></div><div class="stat-value" data-mission-clock>${durationClock(remaining/1000)}</div><div class="stat-note">z 24 godzin operacji</div></article><article class="stat"><div class="stat-label">UCZESTNICY <span>♟</span></div><div class="stat-value">${state.participants.length}</div><div class="stat-note"><b class="tone-lime">${counts.sere}</b> SERE · <b class="tone-orange">${counts.opfor}</b> OPFOR</div></article><article class="stat"><div class="stat-label">AKTYWNE SOS <span class="tone-red">✚</span></div><div class="stat-value tone-red">${counts.sos}</div><div class="stat-note">najwyższy priorytet</div></article><article class="stat"><div class="stat-label">TIMERY <span>◷</span></div><div class="stat-value tone-orange">${counts.timers}</div><div class="stat-note">aktywnych teraz</div></article><article class="stat"><div class="stat-label">NARUSZENIA <span>⚠</span></div><div class="stat-value tone-orange">${counts.outside}</div><div class="stat-note">poza terenem</div></article><article class="stat"><div class="stat-label">ŁĄCZNOŚĆ <span>⌁</span></div><div class="stat-value tone-lime">${navigator.onLine?'100%':'OFF'}</div><div class="stat-note">${state.offlineQueue.length} zdarzeń w kolejce</div></article></section>
  ${adminContent()}
  </main></div>`;
  if(state.game.state==='ACTIVE') timerInterval=setInterval(()=>{const el=$('[data-mission-clock]');if(el){const left=Math.max(0,state.game.durationMinutes*60000-(Date.now()-state.game.startedAt));el.textContent=durationClock(left/1000);}},1000);
}
function adminSessionSelect(){const games=ui.adminGames.length?ui.adminGames:[state.game];return `<label class="session-switch"><span>SESJA</span><select class="select" id="admin-session">${games.map(game=>`<option value="${game.id}" ${game.id===state.game.id?'selected':''}>${esc(game.code)} · ${esc(game.name)}</option>`).join('')}</select></label>`;}
function renderAdminLogin(){ $('#app').innerHTML=`<main class="join-shell"><section class="join-form-side">${brand()}<form class="join-form" id="admin-login"><div class="eyebrow">Bezpieczny dostęp</div><h1>Panel dowodzenia</h1><p class="lead">Zaloguj się jako organizator przy użyciu hasła administratora skonfigurowanego dla serwera.</p><div class="field"><label class="label">KRYPTONIM</label><input class="input" value="GAME-MASTER" disabled></div><div class="field"><label class="label" for="admin-pin">HASŁO ADMINISTRATORA</label><input id="admin-pin" class="input" type="password" maxlength="128" autocomplete="current-password" autofocus></div><button class="btn btn-primary" style="width:100%">Wejdź do centrum dowodzenia</button><p class="hint">Hasło produkcyjne jest przechowywane wyłącznie jako poufna zmienna środowiskowa serwera.</p></form></section><aside class="join-visual"><div class="visual-copy"><div class="visual-number">C2</div><h2>Pełna świadomość sytuacyjna.</h2><p>Jedno centrum dla lokalizacji, alarmów, statusów i decyzji organizatora.</p></div></aside></main>`; }
function gameActions(){ if(state.game.state==='LOBBY')return`<button class="btn btn-primary" data-game="start">${icons.play} Rozpocznij grę</button>`;if(state.game.state==='ACTIVE')return`<button class="btn" data-game="pause">${icons.pause} Wstrzymaj</button><button class="btn btn-danger" data-game="finish">${icons.stop} Zakończ</button>`;if(state.game.state==='PAUSED')return`<button class="btn btn-primary" data-game="resume">${icons.play} Wznów</button><button class="btn btn-danger" data-game="finish">${icons.stop} Zakończ</button>`;return`<button class="btn btn-primary" data-game="reset">↻ Nowa sesja</button>`; }
function adminContent(){
  if(ui.adminTab==='participants') return `<div class="panel"><div class="panel-head"><div class="panel-title">Wszyscy uczestnicy</div><div class="panel-sub">status, drużyna, GPS i bezpieczeństwo</div></div><div>${state.participants.length?state.participants.map(participantAdminCard).join(''):'<div class="empty">Nikt jeszcze nie dołączył do gry.</div>'}</div></div>`;
  if(ui.adminTab==='events') return `<div class="panel"><div class="panel-head"><div class="panel-title">Historia zdarzeń</div><div class="panel-tools"><select class="select" id="event-filter" style="min-height:34px"><option value="ALL">Wszystkie typy</option><option value="SOS">SOS</option><option value="TIMER">Timery</option><option value="BOUNDARY">Granice</option></select></div></div><div class="timeline">${eventsHtml(state.events)}</div></div>`;
  if(ui.adminTab==='report') return reportHtml();
  if(ui.adminTab==='map') return `<div class="panel"><div class="panel-head"><div class="panel-title">Mapa operacyjna live</div><div class="panel-sub">pełna projekcja administratora</div></div>${mapHtml(state.participants,'ADMIN',600)}</div>`;
  if(ui.adminTab==='settings') return settingsHtml();
  const activeAlerts=state.sos.filter(s=>['ACTIVE','ACKNOWLEDGED'].includes(s.status));
  return `${activeAlerts.length?`<section class="panel" style="margin-bottom:14px;border-color:#79312b"><div class="panel-head"><div class="panel-title tone-red">✚ AKTYWNE ALARMY SOS</div><div class="panel-sub">wymagają obsługi organizatora</div></div>${activeAlerts.map(s=>`<article class="roster-card"><div class="team-badge" style="color:var(--red);background:#321613">SOS</div><div><div class="callsign">${esc(s.callsign)} · ${s.team}</div><div class="roster-meta">${mgrs(s.lat,s.lon)} · ${ago(s.time)}</div></div><div class="input-row"><button class="btn btn-sm btn-warning" data-sos-status="ACKNOWLEDGED" data-sos-id="${s.id}" ${s.status==='ACKNOWLEDGED'?'disabled':''}>Potwierdź</button><button class="btn btn-sm btn-primary" data-sos-status="RESOLVED" data-sos-id="${s.id}">Rozwiązany</button><button class="btn btn-sm" data-sos-status="FALSE_ALARM" data-sos-id="${s.id}">Fałszywy</button></div></article>`).join('')}</section>`:''}<section class="dashboard-grid"><div class="panel"><div class="panel-head"><div class="panel-title">Mapa operacyjna</div><div class="panel-sub">aktualizacja live</div><div class="panel-tools"><button class="btn btn-sm btn-ghost" data-action="simulate">⚄ Symuluj ruch</button><button class="btn btn-sm btn-ghost" data-tab="map">Pełny ekran</button></div></div>${mapHtml(state.participants,'ADMIN')}</div><aside class="panel"><div class="panel-head"><div class="panel-title">Uczestnicy</div><div class="panel-sub">${state.participants.length} online</div></div><div class="roster">${state.participants.map(rosterCard).join('')}</div></aside></section><section class="lower-grid"><div class="panel"><div class="panel-head"><div class="panel-title">Ostatnie zdarzenia</div><button class="btn btn-sm btn-ghost" style="margin-left:auto" data-tab="events">Cała historia</button></div><div class="timeline">${eventsHtml(state.events.slice(0,7))}</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Komunikat operacyjny</div></div><form class="quick-message" id="message-form"><div class="field"><select class="select" id="audience"><option>WSZYSCY</option><option>SERE</option><option>OPFOR</option></select></div><textarea class="textarea" id="message-body" maxlength="300" placeholder="Treść komunikatu..."></textarea><button class="btn btn-blue" style="width:100%;margin-top:9px">Wyślij komunikat</button></form></div></section>`;
}
function rosterCard(p){ const stale=Date.now()-p.lastSeen>60000; const critical=p.activeSos||p.outside; return `<article class="roster-card" data-participant="${p.id}"><div class="team-badge ${p.team.toLowerCase()}">${p.team==='SERE'?'SR':'OP'}</div><div><div class="callsign">${esc(p.callsign)} ${p.activeSos?'<span class="tone-red">SOS</span>':''}</div><div class="roster-meta"><span>${p.team}</span><span>⌖ ${p.hasLocation?mgrs(p.lat,p.lon):'BRAK GPS'}</span><span>▰ ${p.battery??'—'}%</span></div></div><div style="text-align:right"><span class="status-pill ${critical?'critical':stale?'warning':''}">${critical?statusLabel(p.status):stale?'ROZŁĄCZONY':statusLabel(p.status)}</span><div class="hint">${ago(p.lastSeen)}</div></div></article>`; }
function participantAdminCard(p){const location=p.hasLocation?`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · ${mgrs(p.lat,p.lon)}`:'Brak prawidłowej pozycji GPS';return `<article class="participant-admin"><div class="participant-summary"><div class="team-badge ${p.team.toLowerCase()}">${p.team==='SERE'?'SR':'OP'}</div><div><div class="callsign">${esc(p.callsign)}</div><div class="roster-meta"><span data-participant-location="${p.id}">${location}</span>${enabled('showBattery')?`<span>▰ ${p.battery??'—'}%</span>`:''}<span data-participant-seen="${p.id}">Aktualizacja: ${ago(p.lastSeen)}</span></div></div><span class="status-pill ${p.activeSos?'critical':''}">${statusLabel(p.status)}</span></div><div class="participant-controls"><label><span>Status</span><select class="select" id="status-${p.id}">${['READY','ACTIVE','CAPTURED','OUTSIDE','DISCONNECTED','FINISHED','REMOVED'].map(s=>`<option value="${s}" ${p.status===s?'selected':''}>${statusLabel(s)}</option>`).join('')}</select></label><label><span>Drużyna</span><select class="select" id="team-${p.id}" ${state.game.state!=='LOBBY'||!enabled('allowTeamChanges')?'disabled':''}><option value="SERE" ${p.team==='SERE'?'selected':''}>SERE</option><option value="OPFOR" ${p.team==='OPFOR'?'selected':''}>OPFOR</option></select></label><button class="btn btn-blue" data-action="participant-save" data-id="${p.id}">Zapisz zmiany</button></div></article>`;}
function settingsHtml(){
  if(!ui.boundaryDraft)ui.boundaryDraft=(state.game.boundary||polygon).map(point=>[...point]);
  const locked=state.game.state==='ACTIVE';
  const featureCards=FEATURE_DEFS.map(([key,label,description,major])=>`<label class="feature-toggle"><input type="checkbox" data-feature="${key}" ${enabled(key)?'checked':''}><span class="feature-switch"></span><span><b>${esc(label)} ${major?'<em>KLUCZOWA</em>':''}</b><small>${esc(description)}</small></span></label>`).join('');
  return `<section class="settings-grid">
  <form class="panel settings-card" id="game-settings-form"><div class="panel-head"><div class="panel-title">Ustawienia bieżącej sesji</div><div class="panel-sub">kod można przekazać uczestnikom natychmiast po zapisie</div></div><div class="settings-body"><div class="settings-row"><div class="field"><label class="label" for="game-code">KOD SESJI</label><input class="input" id="game-code" value="${esc(state.game.code)}" minlength="4" maxlength="16"></div><div class="field"><label class="label" for="game-name">NAZWA SZKOLENIA</label><input class="input" id="game-name" value="${esc(state.game.name)}" maxlength="100"></div></div><div class="settings-row"><div class="field"><label class="label" for="game-duration">CZAS GRY (MIN)</label><input class="input" id="game-duration" type="number" min="10" max="2880" value="${state.game.durationMinutes}"></div><div class="field"><label class="label" for="sere-seconds">TIMER SERE (S)</label><input class="input" id="sere-seconds" type="number" min="5" max="600" value="${state.game.sereSeconds}"></div><div class="field"><label class="label" for="opfor-seconds">RESPAWN OPFOR (S)</label><input class="input" id="opfor-seconds" type="number" min="5" max="600" value="${state.game.opforSeconds}"></div></div><button class="btn btn-primary" style="width:100%">Zapisz ustawienia</button></div></form>
  <form class="panel settings-card" id="new-session-form"><div class="panel-head"><div class="panel-title">Nowa równoległa sesja</div><div class="panel-sub">działa niezależnie od obecnej gry</div></div><div class="settings-body"><div class="settings-row"><div class="field"><label class="label" for="new-game-code">NOWY KOD</label><input class="input" id="new-game-code" minlength="4" maxlength="16" placeholder="np. ORZEL25" required></div><div class="field"><label class="label" for="new-game-name">NAZWA</label><input class="input" id="new-game-name" maxlength="100" placeholder="np. Operacja Orzeł" required></div></div><label class="consent"><input type="checkbox" id="clone-settings" checked><span>Skopiuj granicę, timery i funkcje z bieżącej sesji.</span></label><button class="btn btn-blue" style="width:100%">Utwórz i przełącz</button></div></form>
  <form class="panel feature-panel" id="feature-settings-form"><div class="panel-head"><div class="panel-title">Funkcje sesji</div><div class="panel-sub">20 niezależnych przełączników · 10 funkcji kluczowych</div></div><div class="feature-grid">${featureCards}</div><div class="settings-body"><button class="btn btn-primary" style="width:100%">Zapisz funkcje</button></div></form>
  <section class="panel boundary-card"><div class="panel-head"><div class="panel-title">Granica terenu gry</div><div class="panel-sub"><span data-boundary-count>${ui.boundaryDraft.length}</span> punktów · kliknij mapę, aby dodać</div></div><div class="boundary-toolbar"><button class="btn btn-sm" data-action="boundary-current">Przywróć zapisaną</button><button class="btn btn-sm" data-action="boundary-clear">Wyczyść punkty</button><label class="radius-field">Promień <input class="input" id="boundary-radius" type="number" min="100" max="10000" value="1000"> m</label><button class="btn btn-sm btn-blue" data-action="boundary-around-me">Obszar wokół mojego GPS</button><button class="btn btn-sm" data-action="boundary-around-center">Obszar wokół środka mapy</button><button class="btn btn-sm btn-primary" data-action="boundary-save" ${locked?'disabled':''}>Zapisz granicę</button></div>${locked?'<div class="status-banner warning" style="margin:12px"><span>!</span><div>Wstrzymaj grę przed zmianą granicy.</div></div>':''}${mapHtml([], 'ADMIN',520,{edit:true,boundary:ui.boundaryDraft,key:'boundary-editor'})}<div class="settings-help">Kliknij mapę, aby dodać narożnik. Przeciągaj zielone punkty kursorem lub palcem. Na komputerze bez odbiornika GPS przesuń mapę w wybrane miejsce i użyj „Obszar wokół środka mapy”.</div></section></section>`;
}
function eventsHtml(items){ return items.length?items.map(e=>`<article class="event"><time class="event-time">${fmtTime(e.time)}</time><div class="event-icon ${e.severity.toLowerCase()}">${e.severity==='CRITICAL'?'✚':e.severity==='WARNING'?'!':'•'}</div><div><div class="event-main">${esc(e.text)}</div><div class="event-detail">${esc(e.type.replaceAll('_',' '))}</div></div></article>`).join(''):`<div class="empty">Brak zdarzeń dla wybranego filtra.</div>`; }
function reportHtml(){ const dist=state.participants.reduce((a,p)=>a+p.distance,0); return `<section class="lower-grid" style="grid-template-columns:1fr 1fr"><div class="panel"><div class="panel-head"><div class="panel-title">Raport końcowy</div></div><div style="padding:22px"><div class="eyebrow">${state.game.code}</div><h2>${state.game.name}</h2><p class="lead">Podsumowanie operacji i danych bezpieczeństwa.</p><div class="stats" style="grid-template-columns:repeat(2,1fr)"><article class="stat"><div class="stat-label">DYSTANS</div><div class="stat-value">${dist.toFixed(1)} km</div></article><article class="stat"><div class="stat-label">ZDARZENIA</div><div class="stat-value">${state.events.length}</div></article><article class="stat"><div class="stat-label">TIMERY</div><div class="stat-value">${state.participants.reduce((a,p)=>a+p.timerCount,0)}</div></article><article class="stat"><div class="stat-label">SOS</div><div class="stat-value tone-red">${state.sos.length}</div></article></div>${enabled('csvExport')?'<button class="btn btn-primary" data-action="export-csv">↓ Eksportuj CSV</button>':''}</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Wyniki uczestników</div></div>${state.participants.map(p=>`<div class="roster-card"><div class="team-badge ${p.team.toLowerCase()}">${p.team[0]}</div><div><div class="callsign">${p.callsign}</div><div class="roster-meta">${p.distance} km · ${p.timerCount} timerów · ${p.boundaryCount} naruszeń</div></div></div>`).join('')}</div></section>`; }

function mapHtml(participants,viewer,height=535,options={}){const id=`field-map-${++mapSerial}`,viewKey=`${state.game.id}:${viewer}:${options.key||(options.edit?'editor':ui.view==='admin'?ui.adminTab:ui.playerTab)}`;mapContexts.set(id,{participants,viewer,options,viewKey});return `<div class="map leaflet-map" id="${id}" style="height:${height}px" aria-label="Mapa terenu gry"><div class="map-loading">Ładowanie mapy…</div></div>`;}
function participantsForMap(context){if(context.viewer==='ADMIN')return state.participants;const me=currentPlayer();return me?visibleForPlayer(me):context.participants;}
function drawUtmGrid(map,layer){
  layer.clearLayers();
  if(!enabled('mgrsGrid'))return;
  const bounds=map.getBounds(),mapCenter=bounds.getCenter(),reference=latLonToUtm(mapCenter.lat,mapCenter.lng);if(!reference)return;
  const corners=[bounds.getSouthWest(),bounds.getNorthWest(),bounds.getSouthEast(),bounds.getNorthEast()].map(p=>latLonToUtm(p.lat,p.lng,reference.zone)).filter(Boolean);if(corners.length!==4)return;
  const minE=Math.min(...corners.map(p=>p.easting)),maxE=Math.max(...corners.map(p=>p.easting)),minN=Math.min(...corners.map(p=>p.northing)),maxN=Math.max(...corners.map(p=>p.northing));
  const zoom=map.getZoom(),step=zoom>=18?100:zoom>=15?1000:10000;
  const firstE=Math.floor(minE/step)*step,firstN=Math.floor(minN/step)*step;
  const style={color:'#d7ff7a',weight:1,opacity:.46,interactive:false,dashArray:step===100?'2 4':'5 5'};
  let count=0;
  for(let e=firstE;e<=maxE+step&&count<40;e+=step,count++){
    const a=utmToLatLon(e,minN-step,reference.zone,reference.northern),b=utmToLatLon(e,maxN+step,reference.zone,reference.northern);
    window.L.polyline([[a.lat,a.lon],[b.lat,b.lon]],style).addTo(layer);
    const label=window.L.divIcon({className:'mgrs-grid-label',html:`E ${String(Math.round(e)).slice(-5)}`,iconSize:[58,16],iconAnchor:[29,8]});
    window.L.marker([a.lat,a.lon],{icon:label,interactive:false}).addTo(layer);
  }
  count=0;
  for(let n=firstN;n<=maxN+step&&count<40;n+=step,count++){
    const a=utmToLatLon(minE-step,n,reference.zone,reference.northern),b=utmToLatLon(maxE+step,n,reference.zone,reference.northern);
    window.L.polyline([[a.lat,a.lon],[b.lat,b.lon]],style).addTo(layer);
    const label=window.L.divIcon({className:'mgrs-grid-label',html:`N ${String(Math.round(n)).slice(-5)}`,iconSize:[58,16],iconAnchor:[29,8]});
    window.L.marker([a.lat,a.lon],{icon:label,interactive:false}).addTo(layer);
  }
}
function initMaps(){
  if(!window.L){if(mapLibraryRetries++<40)setTimeout(initMaps,100);else $$('.map-loading').forEach(el=>el.textContent='Mapa niedostępna — odśwież stronę lub sprawdź połączenie.');return;}
  mapLibraryRetries=0;
  for(const [id,context] of mapContexts){
    const element=document.getElementById(id);if(!element)continue;element.innerHTML='';
    const boundaryPoints=(context.options.boundary||state.game.boundary||polygon).map(([lat,lon])=>[lat,lon]);
    const located=participantsForMap(context).filter(p=>p.hasLocation||params.get('demo')==='1');
    const fallback=located[0]?[located[0].lat,located[0].lon]:boundaryPoints[0]||[center.lat,center.lon];
    if(element._leaflet_id)continue;
    const savedView=mapViewState.get(context.viewKey);
    const map=window.L.map(element,{zoomControl:true,attributionControl:true,preferCanvas:true,zoomAnimation:true,fadeAnimation:true,markerZoomAnimation:true});
    if(savedView)map.setView([savedView.lat,savedView.lon],savedView.zoom,{animate:false});else map.setView(fallback,15,{animate:false});
    const satellite=window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Tiles © Esri, Maxar, Earthstar Geographics i GIS User Community',crossOrigin:true});
    const streets=window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap',crossOrigin:true});
    (enabled('satelliteDefault')?satellite:streets).addTo(map);window.L.control.layers({'Satelita':satellite,'Mapa drogowa':streets},{},{position:'topright'}).addTo(map);
    window.L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
    let boundaryLayer=null;const vertexLayer=window.L.layerGroup().addTo(map),markerLayer=window.L.layerGroup().addTo(map),gridLayer=window.L.layerGroup().addTo(map),participantMarkers=new Map();
    const drawBoundary=()=>{
      if(boundaryLayer)boundaryLayer.remove();vertexLayer.clearLayers();
      const points=context.options.edit?ui.boundaryDraft:boundaryPoints;
      if(points?.length>=2)boundaryLayer=window.L.polygon(points,{color:'#a3ff4f',weight:3,fillColor:'#71b13b',fillOpacity:.12,dashArray:context.options.edit?'7 6':null}).addTo(map);
      if(context.options.edit)for(const [index,point] of (points||[]).entries()){
        const icon=window.L.divIcon({className:'boundary-vertex-wrap',html:'<div class="boundary-vertex"></div>',iconSize:[26,26],iconAnchor:[13,13]});
        const marker=window.L.marker(point,{icon,draggable:true,bubblingMouseEvents:false,title:`Punkt granicy ${index+1}`}).addTo(vertexLayer);
        marker.on('drag',event=>{const p=event.target.getLatLng();ui.boundaryDraft[index]=[Number(p.lat.toFixed(7)),Number(p.lng.toFixed(7))];boundaryLayer?.setLatLngs(ui.boundaryDraft);});
      }
      const count=$('[data-boundary-count]');if(count)count.textContent=(points||[]).length;
    };
    const drawParticipants=()=>{
      const locatedNow=participantsForMap(context).filter(item=>item.hasLocation||params.get('demo')==='1'),visibleIds=new Set(locatedNow.map(p=>p.id));
      for(const [participantId,marker] of participantMarkers)if(!visibleIds.has(participantId)){markerLayer.removeLayer(marker);participantMarkers.delete(participantId);}
      for(const p of locatedNow){
        const tooltip=`<b>${esc(p.callsign)}</b><br>${p.team} · ${statusLabel(p.status)}${enabled('showAccuracy')?`<br>±${Math.round(p.accuracy||0)} m`:''}<br>${mgrs(p.lat,p.lon)}`;
        const existing=participantMarkers.get(p.id);if(existing){existing.setLatLng([p.lat,p.lon]);existing.setTooltipContent(tooltip);continue;}
        const tone=p.activeSos?'sos':p.team.toLowerCase();
        const icon=window.L.divIcon({className:'fm-marker-wrap',html:`<div class="fm-map-marker ${tone}">${p.activeSos?'!':p.team==='SERE'?'S':'O'}</div>`,iconSize:[26,26],iconAnchor:[13,13]});
        const marker=window.L.marker([p.lat,p.lon],{icon,title:p.callsign,zIndexOffset:p.activeSos?1000:0}).addTo(markerLayer);
        marker.bindTooltip(tooltip,{direction:'top',offset:[0,-12]});participantMarkers.set(p.id,marker);
      }
    };
    drawBoundary();
    drawParticipants();drawUtmGrid(map,gridLayer);
    if(!savedView&&boundaryPoints.length>=3&&!context.options.edit)map.fitBounds(boundaryPoints,{padding:[24,24],maxZoom:16});
    if(context.options.edit){
      if(!savedView&&boundaryPoints.length>=3)map.fitBounds(boundaryPoints,{padding:[24,24],maxZoom:16});
      map.on('click',event=>{ui.boundaryDraft||=[];ui.boundaryDraft.push([Number(event.latlng.lat.toFixed(7)),Number(event.latlng.lng.toFixed(7))]);drawBoundary();});
    }
    const controller={map,context,drawBoundary,drawParticipants};
    map.on('moveend zoomend',()=>{drawUtmGrid(map,gridLayer);rememberMapView(controller);});
    activeMaps.push(controller);
    setTimeout(()=>map.invalidateSize(),0);
  }
}
function updateActiveMaps(){for(const controller of activeMaps){try{controller.drawParticipants();}catch{}}}
function updateBoundaryEditor({fit=false}={}){for(const controller of activeMaps){if(!controller.context.options.edit)continue;controller.drawBoundary();if(fit&&ui.boundaryDraft?.length>=3)controller.map.fitBounds(ui.boundaryDraft,{padding:[24,24],maxZoom:17});}}

function playerCoordinates(me){return me.hasLocation?`${mgrs(me.lat,me.lon)} · ${me.lat.toFixed(5)}, ${me.lon.toFixed(5)} · ±${Math.round(me.accuracy||0)} m`:'BRAK POZYCJI GPS';}
function playerLocationBanner(me){return !me.hasLocation?`<div class="status-banner warning"><span>⌖</span><div>OCZEKIWANIE NA POZYCJĘ GPS<small style="display:block;color:#ddb88e;margin-top:3px">${esc(ui.gpsMessage||'Włącz dokładną lokalizację dla tej strony.')}</small></div></div>`:me.outside?`<div class="status-banner warning"><span>⚠</span><div>OPUŚCIŁEŚ TEREN GRY<small style="display:block;color:#ddb88e;margin-top:3px">Alarm przypomina co 30 sekund. Wróć do wyznaczonego obszaru.</small></div></div>`:`<div class="status-banner"><span>●</span><div>${state.game.state==='ACTIVE'?'JESTEŚ W OBSZARZE GRY':`GPS GOTOWY · ${statusLabel(state.game.state)}`}<small style="display:block;color:var(--muted);margin-top:3px">Pozycja zaktualizowana ${ago(me.lastSeen)}</small></div></div>`;}
function currentGpsLabel(){const demoGps=params.get('demo')==='1';return demoGps?'GPS · TRYB DEMO':!window.isSecureContext?'GPS WYMAGA HTTPS':geoWatch!==null?(ui.gpsStatus==='OK'?'GPS UDOSTĘPNIANY':'GPS · ŁĄCZENIE'):ui.gpsStatus==='ERROR'?'GPS NIEDOSTĘPNY':'GPS OCZEKUJE';}
function updateLiveLocationDom(){
  const me=currentPlayer();if(me){const coordinates=$('[data-live-coordinates]'),banner=$('[data-live-location-banner]'),gpsLabel=$('[data-live-gps-label]');if(coordinates)coordinates.textContent=playerCoordinates(me);if(banner)banner.innerHTML=playerLocationBanner(me);if(gpsLabel)gpsLabel.textContent=currentGpsLabel();}
  for(const p of state.participants){const location=$(`[data-participant-location="${p.id}"]`),seen=$(`[data-participant-seen="${p.id}"]`);if(location)location.textContent=p.hasLocation?`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · ${mgrs(p.lat,p.lon)}`:'Brak prawidłowej pozycji GPS';if(seen)seen.textContent=`Aktualizacja: ${ago(p.lastSeen)}`;}
}

function currentPlayer(){
  const demo=params.get('demo')==='1';const requestedCallsign=demo?params.get('callsign'):null; const requestedTeam=demo?params.get('team'):null;
  const id=localStorage.getItem('fieldmaster-player-id');
  let p=requestedCallsign?state.participants.find(x=>x.callsign.toUpperCase()===requestedCallsign.toUpperCase()):state.participants.find(x=>x.id===id);
  if(!p&&demo){ const callsign=requestedCallsign||'RAVEN',team=requestedTeam||'SERE';p=state.participants.find(x=>x.callsign===callsign)||state.participants.find(x=>x.team===team); }
  if(p)localStorage.setItem('fieldmaster-player-id',p.id);
  return p;
}
function clearPlayerSession(message='Sesja uczestnika jest nieważna.'){
  localStorage.removeItem('fm-player-token');localStorage.removeItem('fieldmaster-player-id');backend.token=null;backend.socket?.disconnect();stopGps();ui.joining=false;
  if(ui.view==='player'){ui.view='join';ui.joinStep=1;history.replaceState({},'',`?view=join`);render();toast('Dołącz ponownie',message,'warning');}
}
function handleUnauthorized(){
  if(ui.view==='admin'){sessionStorage.removeItem('fm-admin');sessionStorage.removeItem('fm-admin-token');backend.token=null;backend.socket?.disconnect();render();toast('Sesja administratora wygasła','Zaloguj się ponownie.','warning');return;}
  clearPlayerSession('Sesja uczestnika wygasła albo serwer został ponownie uruchomiony.');
}
function visibleForPlayer(me){ return state.participants.filter(p=>p.id===me.id||p.activeSos||(enabled('opforTeamMap')&&me.team==='OPFOR'&&p.team==='OPFOR')); }
function renderPlayer(){
  const me=currentPlayer(); if(!me){ui.view='join';renderJoin();return;}
  manageGps(me);
  const demoGps=params.get('demo')==='1';
  const gpsLabel=currentGpsLabel();
  const activeSos=state.sos.find(s=>['ACTIVE','ACKNOWLEDGED'].includes(s.status));
  if(me.timerEnd>Date.now()){ renderTimer(me); return; }
  if(me.timerEnd&&me.timerEnd<=Date.now()){ me.timerEnd=null;me.status='ACTIVE';addEvent('TIMER_FINISHED',`${me.callsign}: ${me.team==='SERE'?'zatrzymanie zakończone':'respawn zakończony'}`,me.id);timerAlarmSequence(); }
  $('#app').innerHTML=`<main class="player-shell"><header class="player-head">${brand()}<div class="player-head-actions">${installButton('btn btn-sm btn-ghost player-install')}<div class="gps-indicator"><i class="dot ${!demoGps&&geoWatch===null?'offline':''}"></i><span data-live-gps-label>${gpsLabel}</span></div></div></header><section class="player-content">
  ${activeSos?`<button class="status-banner critical" style="width:100%;text-align:left" data-action="focus-sos"><span>✚</span><div>AKTYWNY SOS — ${esc(activeSos.callsign)}<small style="display:block;color:#d7aaa6;margin-top:3px">${mgrs(activeSos.lat,activeSos.lon)} · pokaż na mapie</small></div></button>`:''}
  <div data-live-location-banner>${playerLocationBanner(me)}</div>
  <article class="mission-card"><div class="mission-card-top"><span class="chip ${me.team==='SERE'?'chip-live':'chip-paused'}">${me.team}</span><span class="status-pill">${statusLabel(me.status)}</span></div><div class="player-callsign">${esc(me.callsign)}</div><div class="coordinates" data-live-coordinates>${playerCoordinates(me)}</div></article>
  ${ui.playerTab==='map'?mapHtml(visibleForPlayer(me),me.team,310):ui.playerTab==='messages'?messagesHtml(me):playerActions(me)}
  </section><nav class="bottom-nav"><button class="${ui.playerTab==='status'?'active':''}" data-player-tab="status"><span class="nav-icon">◉</span>STATUS</button><button class="${ui.playerTab==='map'?'active':''}" data-player-tab="map"><span class="nav-icon">⌖</span>MAPA</button>${enabled('sos')?'<button class="sos-nav" data-action="sos-open"><span class="nav-icon">✚</span>SOS</button>':''}</nav></main>`;
}
function playerActions(me){ const actions=[enabled('timers')?`<button class="action-card" data-action="timer-start"><span class="action-icon">◷</span><div class="action-title">${me.team==='SERE'?'Aktywuj zatrzymanie':'Aktywuj respawn'}</div><div class="action-note">${me.team==='SERE'?state.game.sereSeconds:state.game.opforSeconds} sekund · zdarzenie widoczne dla admina</div></button>`:'',enabled('sos')?'<button class="action-card sos" data-action="sos-open"><span class="action-icon">✚</span><div class="action-title">Wezwij pomoc</div><div class="action-note">Podwójne potwierdzenie · pozycja widoczna wszystkim</div></button>':''].join('');return `<div class="action-grid">${actions||'<div class="empty">Akcje uczestnika są wyłączone przez administratora.</div>'}</div>${enabled('adminMessages')?`<article class="mission-card" style="margin-top:12px"><div class="panel-title">Ostatni komunikat</div>${state.messages.length?`<p style="line-height:1.6">${esc(state.messages[0].body)}</p><div class="hint">${fmtTime(state.messages[0].time)} · GAME-MASTER</div>`:`<p class="hint">Brak nowych komunikatów.</p>`}</article>`:''}`; }
function messagesHtml(me){ const msgs=state.messages.filter(m=>m.audience==='WSZYSCY'||m.audience===me.team);return `<div class="panel"><div class="panel-head"><div class="panel-title">Komunikaty</div></div>${msgs.length?msgs.map(m=>`<article class="event"><time class="event-time">${fmtTime(m.time)}</time><div class="event-icon">✦</div><div><div class="event-main">${esc(m.body)}</div><div class="event-detail">GAME-MASTER · ${m.audience}</div></div></article>`).join(''):`<div class="empty">Brak komunikatów.</div>`}</div>`; }
function renderTimer(me){ const total=me.team==='SERE'?state.game.sereSeconds:state.game.opforSeconds; const left=(me.timerEnd-Date.now())/1000; const progress=Math.max(0,left/total*100); if(Date.now()-lastBeep>1000){beep(left<6?980:640,.1,left<6?.16:.1);lastBeep=Date.now();}
  $('#app').innerHTML=`<main class="player-shell"><header class="player-head">${brand()}<div class="gps-indicator"><i class="dot"></i>TIMER AKTYWNY</div></header><section class="player-content"><div class="timer-copy"><div class="eyebrow">${me.team} · ${me.team==='SERE'?'ZATRZYMANIE':'RESPAWN'}</div><div class="timer-ring" style="--progress:${progress}%"><div class="big-timer" data-timer-clock>${clock(left)}</div></div><h1>${me.team==='SERE'?'Pozostań w miejscu':'Oczekuj na respawn'}</h1><p>Sygnał zakończenia zwolni Cię automatycznie. Administrator widzi aktywny timer.</p></div><div class="status-banner warning"><span>!</span><div>Timer nie jest funkcją alarmową<small style="display:block;color:#ddb88e;margin-top:3px">SOS pozostaje dostępny poniżej.</small></div></div><button class="btn btn-danger" style="width:100%;height:58px" data-action="sos-open">✚ SOS — WEZWIJ POMOC</button></section></main>`;
  timerInterval=setInterval(()=>tickPlayerTimer(me,total),250);
}
function tickPlayerTimer(me,total){const left=(me.timerEnd-Date.now())/1000;if(left<=0){stopTimerTicker();me.timerEnd=null;me.status='ACTIVE';addEvent('TIMER_FINISHED',`${me.callsign}: ${me.team==='SERE'?'zatrzymanie zakończone':'respawn zakończony'}`,me.id);timerAlarmSequence();render();return;}const clockEl=$('[data-timer-clock]');const ring=$('.timer-ring');if(clockEl)clockEl.textContent=clock(left);if(ring)ring.style.setProperty('--progress',`${Math.max(0,left/total*100)}%`);if(Date.now()-lastBeep>1000){beep(left<6?980:640,.1,left<6?.16:.1);lastBeep=Date.now();}}
function stopTimerTicker(){if(timerInterval){clearInterval(timerInterval);timerInterval=null;}}

function bindGlobal(){
  $$('#app [data-tab]').forEach(b=>b.onclick=()=>{ui.adminTab=b.dataset.tab;render();});
  $$('#app [data-player-tab]').forEach(b=>b.onclick=()=>{ui.playerTab=b.dataset.playerTab;render();});
  $$('#app [data-team]').forEach(b=>b.onclick=()=>{ui.team=b.dataset.team;render();});
  $$('#app [data-consent]').forEach(c=>c.onchange=()=>{ui[c.dataset.consent]=c.checked;});
  $('#callsign')?.addEventListener('input',e=>ui.callsign=e.target.value.toUpperCase());
  $('#session-code')?.addEventListener('input',e=>ui.sessionCode=e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g,''));
  $$('[data-game]').forEach(b=>b.onclick=()=>changeGame(b.dataset.game));
  $$('[data-sos-status]').forEach(b=>b.onclick=()=>setSosStatus(b.dataset.sosId,b.dataset.sosStatus));
  $$('[data-action]').forEach(b=>b.onclick=()=>handleAction(b.dataset.action,b));
  $('#admin-login')?.addEventListener('submit',adminLogin);
  $('#message-form')?.addEventListener('submit',sendMessage);
  $('#game-settings-form')?.addEventListener('submit',saveGameSettings);
  $('#feature-settings-form')?.addEventListener('submit',saveFeatures);
  $('#new-session-form')?.addEventListener('submit',createSession);
  $('#admin-session')?.addEventListener('change',e=>switchAdminSession(e.target.value));
}
async function loadAdminGames(){if(!backend.available||!backend.token)return;ui.adminGames=await api('/api/games');}
async function switchAdminSession(gameId){
  try{const data=await api(`/api/state?gameId=${encodeURIComponent(gameId)}`);assignSnapshot(data);backend.gameId=gameId;sessionStorage.setItem('fm-admin-game-id',gameId);ui.boundaryDraft=null;connectRealtime(backend.token,gameId);render();}catch(error){toast('Nie przełączono sesji',error.message,'critical');}
}
async function createSession(e){
  e.preventDefault();const code=$('#new-game-code').value.trim().toUpperCase(),name=$('#new-game-name').value.trim();
  try{const game=await api('/api/games',{method:'POST',body:JSON.stringify({code,name,cloneSettingsFrom:$('#clone-settings').checked?state.game.id:undefined})});await loadAdminGames();await switchAdminSession(game.id);toast('Sesja utworzona',`Kod ${game.code} jest gotowy dla uczestników.`);}catch(error){toast('Nie utworzono sesji',error.message,'critical');}
}
async function saveFeatures(e){
  e.preventDefault();const features=Object.fromEntries($$('[data-feature]',e.currentTarget).map(input=>[input.dataset.feature,input.checked]));
  try{state.game=normalizeGame(await api(`/api/games/${state.game.id}/settings`,{method:'PATCH',body:JSON.stringify({features})}));toast('Funkcje zapisane','Zmiany obowiązują natychmiast w tej sesji.');render();}catch(error){toast('Nie zapisano funkcji',error.message,'critical');}
}
async function adminLogin(e){
  e.preventDefault();const pin=$('#admin-pin').value;
  try{
    if(backend.available){const result=await api('/api/auth/admin',{method:'POST',body:JSON.stringify({callsign:'GAME-MASTER',password:pin})},null);sessionStorage.setItem('fm-admin-token',result.token);backend.token=result.token;await loadAdminGames();backend.gameId=sessionStorage.getItem('fm-admin-game-id')||result.gameId;assignSnapshot(await api(`/api/state?gameId=${backend.gameId}`));connectRealtime(result.token,backend.gameId);}
    else if(backend.required)throw new Error('Serwer jest niedostępny. Sprawdź internet i spróbuj ponownie.');
    else if(pin!=='2468')throw new Error('Nieprawidłowy PIN.');
    sessionStorage.setItem('fm-admin','ok');render();
  }catch(error){toast('Odmowa dostępu',error.message,'critical');}
}
async function sendMessage(e){
  e.preventDefault();const body=$('#message-body').value.trim(),audience=$('#audience').value;if(!body)return;
  try{
    if(backend.available){const message=await api('/api/messages',{method:'POST',body:JSON.stringify({gameId:state.game.id,body,audience:audience==='WSZYSCY'?'ALL':audience})});state.messages.unshift(message);}
    else{state.messages.unshift({id:uid(),body,audience,time:Date.now()});addEvent('ADMIN_MESSAGE',`Komunikat do: ${audience}`);}
    beep(720,.12);toast('Komunikat wysłany',body);render();
  }catch(error){toast('Nie wysłano komunikatu',error.message,'critical');}
}
function handleAction(action,button){
  if(action==='join-next') nextJoin();
  if(action==='join-back'){ui.joinStep=Math.max(1,ui.joinStep-1);render();}
  if(action==='test-sound'){unlockAudio();beep(660,.18,.16);setTimeout(()=>beep(920,.22,.2),240);setTimeout(()=>beep(1180,.32,.24),520);toast('Test dźwięku','Odtworzono głośny sygnał końcowy.');}
  if(action==='test-gps') requestGpsTest();
  if(action==='timer-start') startTimer();
  if(action==='sos-open') showSosModal();
  if(action==='simulate') simulateMovement();
  if(action==='export-csv') exportCsv();
  if(action==='boundary-current'){ui.boundaryDraft=(state.game.boundary||polygon).map(point=>[...point]);updateBoundaryEditor();}
  if(action==='boundary-clear'){ui.boundaryDraft=[];updateBoundaryEditor();toast('Punkty wyczyszczone','Widok mapy pozostał w tej samej pozycji.');}
  if(action==='boundary-around-me') boundaryAroundMe();
  if(action==='boundary-around-center') boundaryAroundCenter();
  if(action==='boundary-save') saveBoundary();
  if(action==='participant-save') saveParticipant(button.dataset.id);
  if(action==='install')installApp();
}
async function installApp(){
  if(ui.installed)return toast('Aplikacja jest zainstalowana','Uruchom ją z ekranu głównego.');
  if(ui.installPrompt){const prompt=ui.installPrompt;ui.installPrompt=null;await prompt.prompt();return;}
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);const backdrop=document.createElement('div');backdrop.className='modal-backdrop';
  backdrop.innerHTML=`<div class="modal" role="dialog" aria-modal="true"><div class="modal-icon">↓</div><h2>Zainstaluj Fieldmaster</h2><p>${ios?'W Safari naciśnij ikonę Udostępnij, przewiń listę i wybierz „Do ekranu początkowego”, a następnie „Dodaj”.':'W menu przeglądarki (⋮) wybierz „Zainstaluj aplikację” lub „Dodaj do ekranu głównego”. Jeżeli opcja nie jest widoczna, otwórz tę stronę w Chrome.'}</p><div class="modal-actions single"><button class="btn btn-primary" data-close>Rozumiem</button></div></div>`;
  document.body.append(backdrop);$('[data-close]',backdrop).onclick=()=>backdrop.remove();
}
async function requestGpsTest(){
  if(!window.isSecureContext&&!['localhost','127.0.0.1'].includes(location.hostname)){ui.gpsStatus='ERROR';render();return toast('GPS wymaga HTTPS','Otwórz aplikację przez bezpieczny publiczny adres HTTPS.','critical');}
  if(!navigator.geolocation){ui.gpsStatus='ERROR';render();return toast('Brak GPS','Ta przeglądarka nie udostępnia geolokalizacji.','critical');}
  try{const permission=await navigator.permissions?.query?.({name:'geolocation'});if(permission?.state==='denied'){ui.gpsStatus='ERROR';ui.gpsMessage='Lokalizacja jest zablokowana. Otwórz ustawienia strony i wybierz „Zezwalaj”.';render();return toast('Lokalizacja zablokowana',ui.gpsMessage,'critical');}}catch{}
  ui.gpsStatus='CHECKING';ui.gpsMessage='';render();toast('Test GPS','Czekam na pozycję urządzenia…');
  const success=pos=>{ui.gpsStatus='OK';ui.gpsAccuracy=pos.coords.accuracy;ui.gpsMessage='';ui.testLocation={lat:pos.coords.latitude,lon:pos.coords.longitude,accuracy:pos.coords.accuracy,timestamp:pos.timestamp};render();toast('GPS działa',`Dokładność ±${Math.round(pos.coords.accuracy)} m.`);};
  const fail=error=>{if(error.code!==1)navigator.geolocation.getCurrentPosition(success,finalError=>{ui.gpsStatus='ERROR';ui.gpsMessage=gpsErrorMessage(finalError);render();toast('GPS niedostępny',ui.gpsMessage,'critical');},{enableHighAccuracy:false,maximumAge:60000,timeout:15000});else{ui.gpsStatus='ERROR';ui.gpsMessage=gpsErrorMessage(error);render();toast('GPS niedostępny',ui.gpsMessage,'critical');}};
  navigator.geolocation.getCurrentPosition(success,fail,{enableHighAccuracy:true,maximumAge:15000,timeout:30000});
}
function gpsErrorMessage(error){return error.code===1?'Lokalizacja jest zablokowana. W ustawieniach tej strony wybierz Lokalizacja → Zezwalaj.':error.code===2?'Telefon nie potrafi ustalić pozycji. Włącz dokładną lokalizację i wyjdź na otwartą przestrzeń.':error.code===3?'GPS nie odpowiedział na czas. Włącz dokładną lokalizację, pozostaw ekran aktywny i spróbuj ponownie.':error.message||'Nieznany błąd GPS.';}
async function saveGameSettings(e){
  e.preventDefault();const payload={code:$('#game-code').value.trim().toUpperCase(),name:$('#game-name').value.trim(),durationMinutes:Number($('#game-duration').value),sereTimerSeconds:Number($('#sere-seconds').value),opforTimerSeconds:Number($('#opfor-seconds').value)};
  try{if(backend.available){state.game=normalizeGame(await api(`/api/games/${backend.gameId||state.game.id}/settings`,{method:'PATCH',body:JSON.stringify(payload)}));await loadAdminGames();}else state.game=normalizeGame({...state.game,...payload});ui.sessionCode=state.game.code;save(false);toast('Ustawienia zapisane','Kod i parametry wysłano do wszystkich urządzeń.');render();}catch(error){toast('Nie zapisano ustawień',error.message,'critical');}
}
async function saveBoundary(){
  if(!ui.boundaryDraft||ui.boundaryDraft.length<3)return toast('Za mało punktów','Granica musi mieć co najmniej 3 punkty.','warning');
  try{const payload={boundary:ui.boundaryDraft};if(backend.available)state.game=normalizeGame(await api(`/api/games/${backend.gameId||state.game.id}/settings`,{method:'PATCH',body:JSON.stringify(payload)}));else state.game.boundary=ui.boundaryDraft.map(point=>[...point]);ui.boundaryDraft=state.game.boundary.map(point=>[...point]);save(false);toast('Granica zapisana',`${ui.boundaryDraft.length} punktów aktywnego obszaru.`);render();}catch(error){toast('Nie zapisano granicy',error.message,'critical');}
}
function boundaryAroundMe(){
  if(!navigator.geolocation)return toast('Brak GPS','Ta przeglądarka nie udostępnia lokalizacji.','critical');
  const radius=Math.max(100,Math.min(10000,Number($('#boundary-radius')?.value||1000)));
  navigator.geolocation.getCurrentPosition(pos=>setBoundaryAround(pos.coords.latitude,pos.coords.longitude),error=>toast('Nie pobrano pozycji',`${gpsErrorMessage(error)} Na komputerze możesz użyć obszaru wokół środka mapy.`,'critical'),{enableHighAccuracy:true,maximumAge:15000,timeout:30000});
}
function setBoundaryAround(lat,lon){const radius=Math.max(100,Math.min(10000,Number($('#boundary-radius')?.value||1000))),dLat=radius/111320,dLon=radius/(111320*Math.cos(lat*Math.PI/180));ui.boundaryDraft=[[lat-dLat,lon-dLon],[lat+dLat,lon-dLon],[lat+dLat,lon+dLon],[lat-dLat,lon+dLon]];updateBoundaryEditor();toast('Obszar utworzony',`Kwadrat o promieniu około ${radius} m. Widok mapy nie został zmieniony.`);}
function boundaryAroundCenter(){const controller=activeMaps.find(item=>item.context.options.edit);if(!controller)return toast('Mapa nie jest gotowa','Poczekaj chwilę i spróbuj ponownie.','warning');const point=controller.map.getCenter();setBoundaryAround(point.lat,point.lng);}
async function saveParticipant(id){
  const payload={status:$(`#status-${id}`).value,team:$(`#team-${id}`).value};
  try{if(backend.available){const updated=normalizeParticipant(await api(`/api/participants/${id}`,{method:'PATCH',body:JSON.stringify(payload)}));const index=state.participants.findIndex(p=>p.id===id);if(index>=0)state.participants[index]=updated;}else Object.assign(state.participants.find(p=>p.id===id),payload);toast('Uczestnik zaktualizowany','Zmiana jest widoczna na wszystkich urządzeniach.');render();}catch(error){toast('Nie zapisano uczestnika',error.message,'critical');}
}
async function nextJoin(){
  if(ui.joining)return;
  if(ui.joinStep===1){
    ui.callsign=$('#callsign')?.value.trim().toUpperCase()||ui.callsign;ui.sessionCode=($('#session-code')?.value||ui.sessionCode||'').trim().toUpperCase();
    if(ui.callsign.length<2)return toast('Kryptonim jest za krótki','Wpisz co najmniej 2 znaki.','warning');
    if(ui.sessionCode.length<4)return toast('Nieprawidłowy kod sesji','Wpisz co najmniej 4 znaki.','warning');
    if(backend.available){try{state.game=normalizeGame(await api(`/api/games/${encodeURIComponent(ui.sessionCode)}/public`,{},null));state.participants=[];}catch(error){return toast('Nie znaleziono sesji',error.message,'critical');}}
    if(state.game.state!=='LOBBY'||!enabled('allowJoining'))return toast('Dołączanie jest zamknięte',`Stan sesji: ${statusLabel(state.game.state)}. Skontaktuj się z organizatorem.`,'warning');
    if(state.participants.some(p=>p.callsign.toUpperCase()===ui.callsign))return toast('Kryptonim zajęty','Wybierz inny kryptonim.','warning');
  }
  if(ui.joinStep===2&&!ui.team)return toast('Wybierz stronę','SERE albo OPFOR.','warning');
  if(ui.joinStep===3&&!(ui.consent&&ui.rules&&ui.locationConsent))return toast('Wymagane zgody','Zaznacz wszystkie trzy pola, aby kontynuować.','warning');
  if(ui.joinStep<4){ui.joinStep++;render();return;}
  unlockAudio();
  if(backend.required&&!backend.available)return toast('Serwer jest niedostępny','Nie tworzę lokalnej, odłączonej kopii uczestnika. Sprawdź internet i spróbuj ponownie za chwilę.','critical');
  ui.joining=true;render();
  try{
    let p;
    if(backend.available){const result=await api(`/api/games/${encodeURIComponent(ui.sessionCode||state.game.code)}/join`,{method:'POST',body:JSON.stringify({callsign:ui.callsign,team:ui.team,consent:true,consentVersion:'2026-07-11'})},null);p=normalizeParticipant(result.participant);state.game=normalizeGame(result.game);state.participants=[p];localStorage.setItem('fm-player-token',result.token);backend.token=result.token;backend.gameId=result.game.id;connectRealtime(result.token,result.game.id);}
    else{p={id:uid(),callsign:ui.callsign,team:ui.team,status:'READY',x:50,y:50,lat:center.lat,lon:center.lon,battery:null,lastSeen:Date.now(),timerCount:0,boundaryCount:0,distance:0};state.participants.push(p);addEvent('PARTICIPANT_JOINED',`${p.callsign} dołączył do ${p.team}`,p.id);}
    if(ui.testLocation){p.lat=ui.testLocation.lat;p.lon=ui.testLocation.lon;p.accuracy=ui.testLocation.accuracy;p.hasLocation=true;p.lastSeen=Date.now();if(backend.available)await sendLocationPayload(p,ui.testLocation,true);}
    localStorage.setItem('fieldmaster-player-id',p.id);localStorage.setItem(`fieldmaster-team-${state.game.id}`,ui.team);ui.view='player';history.replaceState({},'',`?view=player`);render();toast('Gotowość potwierdzona','Drużyna została zablokowana dla tej sesji.');
  }catch(error){ui.joining=false;render();toast('Nie udało się dołączyć',error.message,'critical');}
}
async function changeGame(action){
  const map={start:'ACTIVE',pause:'PAUSED',resume:'ACTIVE',finish:'FINISHED',reset:'LOBBY'};
  try{
    if(backend.available){const game=await api(`/api/games/${backend.gameId||state.game.id}/${action}`,{method:'POST'});state.game=normalizeGame(game);if(action==='start')resetGameMapViews(state.game.id);}
    else{if(action==='reset'){const fresh=initialState();state={...fresh,game:{...fresh.game,name:state.game.name,boundary:state.game.boundary,durationMinutes:state.game.durationMinutes,sereSeconds:state.game.sereSeconds,opforSeconds:state.game.opforSeconds}};}else{state.game.state=map[action];if(action==='start'){state.game.startedAt=Date.now();state.participants.forEach(p=>p.status='ACTIVE');}if(action==='finish'){state.game.finishedAt=Date.now();state.participants.forEach(p=>p.status='FINISHED');stopGps();}addEvent(`GAME_${map[action]}`,`GAME-MASTER: ${statusLabel(map[action]).toLowerCase()}`);}}
    render();
  }catch(error){toast('Nie zmieniono stanu gry',error.message,'critical');}
}
async function startTimer(){
  const me=currentPlayer();if(!enabled('timers'))return toast('Timer wyłączony','Administrator wyłączył timery w tej sesji.','warning');if(state.game.state!=='ACTIVE')return toast('Gra nie jest aktywna','Timer można uruchomić po starcie.','warning');if(me.timerEnd>Date.now())return;
  try{unlockAudio();const seconds=me.team==='SERE'?state.game.sereSeconds:state.game.opforSeconds;if(backend.available){const timer=await api('/api/timers',{method:'POST',body:'{}'});me.timerEnd=Number(timer.endsAt);}else{me.timerEnd=Date.now()+seconds*1000;me.timerCount++;me.status=me.team==='SERE'?'TIMER':'RESPAWN';addEvent('TIMER_STARTED',`${me.callsign} aktywował timer ${seconds} s`,me.id,'WARNING');}beep(520,.14,.14);render();}catch(error){toast('Nie uruchomiono timera',error.message,'critical');}
}

function showSosModal(){
  if(!enabled('sos'))return toast('SOS wyłączony','Użyj kanału ratunkowego organizatora lub numeru 112.','warning');
  const me=currentPlayer(); const backdrop=document.createElement('div');backdrop.className='modal-backdrop';backdrop.innerHTML=`<div class="modal danger" role="dialog" aria-modal="true" aria-labelledby="sos-title"><div class="modal-icon">✚</div><h2 id="sos-title">Czy potrzebujesz pomocy?</h2><p>Aktywacja ujawni Twoją pozycję wszystkim uczestnikom, uruchomi alarm i powiadomi organizatora. W zagrożeniu życia dzwoń także pod 112.</p><div class="modal-actions"><button class="btn btn-ghost" data-close>Anuluj</button><button class="btn btn-danger" data-confirm>Dalej — potwierdź</button></div></div>`;document.body.append(backdrop);$('[data-close]',backdrop).onclick=()=>backdrop.remove();$('[data-confirm]',backdrop).onclick=()=>{backdrop.innerHTML=`<div class="modal danger"><div class="modal-icon">!</div><h2>Drugie potwierdzenie</h2><p>Przytrzymaj czerwony przycisk przez 2 sekundy. Alarm zostanie wysłany natychmiast po wypełnieniu paska.</p><div class="modal-actions"><button class="btn btn-ghost" data-close>Anuluj</button><button class="btn btn-danger hold-button" data-hold style="--hold:0%"><span>PRZYTRZYMAJ — SOS</span></button></div></div>`;bindHold(backdrop,me);}; }
function bindHold(root,me){ $('[data-close]',root).onclick=()=>root.remove();const b=$('[data-hold]',root);let start=0,raf;const stop=()=>{cancelAnimationFrame(raf);start=0;b.style.setProperty('--hold','0%');};const tick=()=>{const pct=Math.min(100,(performance.now()-start)/20);b.style.setProperty('--hold',`${pct}%`);if(pct>=100){activateSos(me);root.remove();}else raf=requestAnimationFrame(tick);};b.onselectstart=e=>e.preventDefault();b.oncontextmenu=e=>e.preventDefault();b.onpointerdown=e=>{e.preventDefault();start=performance.now();b.setPointerCapture?.(e.pointerId);raf=requestAnimationFrame(tick);};b.onpointerup=stop;b.onpointercancel=stop; }
async function activateSos(me){
  if(!navigator.onLine)toast('UWAGA: brak internetu','Alarm zapisano lokalnie, ale może nie dotrzeć. Użyj telefonu/radia/112!','critical');
  try{let alert;if(backend.available)alert=normalizeAlert(await api('/api/sos',{method:'POST',body:'{}'}));else{alert={id:uid(),participantId:me.id,callsign:me.callsign,team:me.team,status:'ACTIVE',lat:me.lat,lon:me.lon,time:Date.now()};addEvent('SOS_ACTIVATED',`SOS — ${me.callsign} potrzebuje pomocy`,me.id,'CRITICAL');}state.sos.unshift(alert);me.activeSos=true;me.status='SOS';alarmSequence();render();}catch(error){toast('SOS nie został wysłany',`${error.message}. Użyj telefonu/radia/112.`,'critical');}
}
async function setSosStatus(id,status){
  const alert=state.sos.find(s=>s.id===id);if(!alert)return;
  try{if(backend.available)Object.assign(alert,normalizeAlert(await api(`/api/sos/${id}`,{method:'PATCH',body:JSON.stringify({status})})));else{alert.status=status;alert.updatedAt=Date.now();const p=state.participants.find(x=>x.id===alert.participantId);if(status!=='ACKNOWLEDGED'&&p){p.activeSos=false;p.status='ACTIVE';}addEvent(`SOS_${status}`,`${alert.callsign}: ${status==='ACKNOWLEDGED'?'alarm przyjęty':status==='RESOLVED'?'alarm rozwiązany':'fałszywy alarm'}`,alert.participantId,status==='ACKNOWLEDGED'?'WARNING':'INFO');}render();}catch(error){toast('Nie zmieniono alarmu',error.message,'critical');}
}
function checkCritical(){ const active=state.sos.find(s=>s.status==='ACTIVE'&&!s.seen);if(active){active.seen=true;save(false);alarmSequence();toast(`SOS — ${active.callsign}`,`${mgrs(active.lat,active.lon)}. Otwórz mapę.`,'critical');} }
function vibrate(pattern){if(enabled('vibration'))navigator.vibrate?.(pattern);}
function alarmSequence(){beep(920,.28,.22);setTimeout(()=>beep(680,.28,.24),320);setTimeout(()=>beep(1060,.5,.3),660);vibrate([300,120,300,120,700]);}

function simulateMovement(){const area=state.game.boundary||polygon;const lat=area.reduce((sum,p)=>sum+p[0],0)/area.length,lon=area.reduce((sum,p)=>sum+p[1],0)/area.length;state.participants.forEach((p,index)=>{p.lat=lat+(Math.random()-.5)*.004;p.lon=lon+(Math.random()-.5)*.006;p.hasLocation=true;p.lastSeen=Date.now();p.distance=Number((p.distance+Math.random()*.14).toFixed(1));});addEvent('LOCATION_BATCH','Zaktualizowano pozycje demonstracyjne');render(); }
function manageGps(me){
  if(params.get('demo')==='1')return;
  if(!enabled('gpsTracking')||(state.game.state!=='ACTIVE'&&!enabled('shareLocationInLobby'))){stopGps();ui.gpsStatus='DISABLED';ui.gpsMessage='GPS wyłączony przez administratora.';return;}
  if(state.game.state==='FINISHED'){stopGps();return;}
  if(!window.isSecureContext){ui.gpsStatus='ERROR';ui.gpsMessage='GPS wymaga bezpiecznego adresu HTTPS.';return;}
  if(!navigator.geolocation){ui.gpsStatus='ERROR';ui.gpsMessage='Ta przeglądarka nie udostępnia GPS.';return;}
  if(geoWatch!==null||gpsRestartTimer)return;
  startGpsWatch(me,true);
}
function startGpsWatch(me,highAccuracy){
  gpsFallback=!highAccuracy;ui.gpsStatus='CHECKING';ui.gpsMessage=highAccuracy?'Łączenie z dokładnym GPS…':'Tryb zgodny GPS — dokładność może być niższa.';
  geoWatch=navigator.geolocation.watchPosition(pos=>onGpsPosition(me,pos),error=>onGpsError(me,error,highAccuracy),{enableHighAccuracy:highAccuracy,maximumAge:highAccuracy?10000:60000,timeout:highAccuracy?30000:20000});
  updateLiveLocationDom();
}
function onGpsPosition(original,pos){
  const me=currentPlayer()||original;if(!me)return;ui.gpsStatus='OK';ui.gpsAccuracy=pos.coords.accuracy;ui.gpsMessage='';
  me.lat=pos.coords.latitude;me.lon=pos.coords.longitude;me.hasLocation=true;me.accuracy=pos.coords.accuracy;me.lastSeen=Date.now();if(batteryLevel!==null)me.battery=batteryLevel;
  const outside=enabled('geofence')&&state.game.state==='ACTIVE'&&!pointInPolygon(me.lat,me.lon,state.game.boundary||polygon);setOutsideState(me,outside);
  if(backend.available)sendLocationPayload(me,{lat:me.lat,lon:me.lon,accuracy:pos.coords.accuracy,timestamp:pos.timestamp,battery:batteryLevel});
  save(false);updateActiveMaps();updateLiveLocationDom();
}
function onGpsError(me,error,highAccuracy){
  ui.gpsStatus='ERROR';ui.gpsMessage=gpsErrorMessage(error);
  if(geoWatch!==null){navigator.geolocation.clearWatch(geoWatch);geoWatch=null;}
  if(error.code!==1&&highAccuracy&&enabled('gpsFallback')){gpsRestartTimer=setTimeout(()=>{gpsRestartTimer=null;startGpsWatch(currentPlayer()||me,false);},1200);toast('Przełączam tryb GPS','Dokładny GPS nie odpowiedział — próbuję trybu zgodnego.','warning');return;}
  if(error.code!==1&&!highAccuracy)gpsRestartTimer=setTimeout(()=>{gpsRestartTimer=null;startGpsWatch(currentPlayer()||me,false);},30000);
  if(Date.now()-gpsErrorShownAt>15000){gpsErrorShownAt=Date.now();toast('GPS niedostępny',ui.gpsMessage,'warning');}
  updateLiveLocationDom();
}
async function sendLocationPayload(me,location,force=false){
  if(!backend.available||gpsSendInFlight||state.game.state==='FINISHED')return;
  const timestamp=Number(location.timestamp)||Date.now();const moved=lastLocationSent?distanceMeters(lastLocationSent.lat,lastLocationSent.lon,location.lat,location.lon):Infinity;
  const accuracyImproved=lastLocationSent&&Number(location.accuracy)<Number(lastLocationSent.accuracy||Infinity)*.75;
  if(!force&&lastLocationSent&&timestamp-lastLocationSent.time<8000&&moved<5&&!accuracyImproved)return;
  lastLocationSent={lat:location.lat,lon:location.lon,accuracy:location.accuracy,time:timestamp};gpsSendInFlight=true;
  try{const result=await api('/api/locations',{method:'POST',body:JSON.stringify({latitude:location.lat,longitude:location.lon,accuracy:location.accuracy,battery:location.battery??undefined,timestamp:new Date(timestamp).toISOString()})});setOutsideState(currentPlayer()||me,Boolean(result.outside));}
  catch(error){if(error.message.includes('sesji')||error.message.includes('ważnej'))handleUnauthorized();else if(Date.now()-gpsErrorShownAt>15000){gpsErrorShownAt=Date.now();toast('Nie wysłano pozycji',error.message,'warning');}}
  finally{gpsSendInFlight=false;}
}
function setOutsideState(me,outside){
  const previous=Boolean(me.outside);me.outside=outside;if(outside)me.status='OUTSIDE';else if(previous&&state.game.state==='ACTIVE')me.status='ACTIVE';
  if(outside&&!previous){me.boundaryCount=(me.boundaryCount||0)+1;startBoundaryAlarm();if(!backend.available)addEvent('BOUNDARY_EXIT',`${me.callsign} opuścił teren gry`,me.id,'WARNING');}
  if(!outside&&previous){stopBoundaryAlarm();beep(760,.18,.12,'sine');if(!backend.available)addEvent('BOUNDARY_RETURN',`${me.callsign} wrócił na teren gry`,me.id);}
}
function startBoundaryAlarm(){if(boundaryAlarmTimer)return;boundaryAlarmSequence();if(enabled('boundaryReminders'))boundaryAlarmTimer=setInterval(boundaryAlarmSequence,30000);}
function stopBoundaryAlarm(){if(boundaryAlarmTimer){clearInterval(boundaryAlarmTimer);boundaryAlarmTimer=null;}}
function boundaryAlarmSequence(){beep(760,.18,.15);setTimeout(()=>beep(540,.22,.18),230);vibrate([300,140,300]);}
function stopGps(){if(geoWatch!==null){navigator.geolocation.clearWatch(geoWatch);geoWatch=null;}if(gpsRestartTimer){clearTimeout(gpsRestartTimer);gpsRestartTimer=null;}stopBoundaryAlarm();gpsFallback=false;lastLocationSent=null;}
function unlockAudio(){try{audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();audioCtx.resume?.();}catch{}}
function beep(freq=650,duration=.1,gain=.1,type='square'){if(!enabled('audioAlarms'))return;try{unlockAudio();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type=type;o.frequency.value=freq;g.gain.setValueAtTime(Math.max(.01,Math.min(.35,gain)),audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+duration);o.connect(g).connect(audioCtx.destination);o.start();o.stop(audioCtx.currentTime+duration);}catch{}}
function timerAlarmSequence(){beep(880,.28,.2);setTimeout(()=>beep(1080,.3,.24),340);setTimeout(()=>beep(1320,.65,.3),700);vibrate([400,120,400,120,800]);}
function exportCsv(){ const rows=[['kryptonim','druzyna','status','dystans_km','timery','naruszenia','bateria'],...state.participants.map(p=>[p.callsign,p.team,p.status,p.distance,p.timerCount,p.boundaryCount,p.battery??''])];rows.push([],['czas','typ','zdarzenie'],...state.events.map(e=>[new Date(e.time).toISOString(),e.type,e.text]));const csv='\ufeff'+rows.map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(';')).join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download=`fieldmaster-${state.game.code}.csv`;a.click();URL.revokeObjectURL(a.href);toast('Raport gotowy','Plik CSV został wygenerowany.'); }

if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
async function initialize(){
  await detectBackend();
  if(backend.available){
    if(ui.view==='admin'){
      const token=sessionStorage.getItem('fm-admin-token');
      if(token){try{backend.token=token;await loadAdminGames();const selected=sessionStorage.getItem('fm-admin-game-id');backend.gameId=ui.adminGames.some(game=>game.id===selected)?selected:(ui.adminGames[0]?.id||state.game.id);assignSnapshot(await api(`/api/state?gameId=${backend.gameId}`,{},token));connectRealtime(token,backend.gameId);}catch{sessionStorage.removeItem('fm-admin');sessionStorage.removeItem('fm-admin-token');}}
      else sessionStorage.removeItem('fm-admin');
    }else{
      const token=localStorage.getItem('fm-player-token');
      if(token){try{assignSnapshot(await api('/api/state',{},token));backend.token=token;backend.gameId=state.game.id;connectRealtime(token,state.game.id);if(ui.view==='join'&&currentPlayer()){ui.view='player';history.replaceState({},'',`?view=player`);}}catch{localStorage.removeItem('fm-player-token');localStorage.removeItem('fieldmaster-player-id');if(ui.view==='player'){ui.view='join';history.replaceState({},'',`?view=join`);}}}
    }
  }
  try{const battery=await navigator.getBattery?.();if(battery){batteryLevel=Math.round(battery.level*100);battery.addEventListener?.('levelchange',()=>batteryLevel=Math.round(battery.level*100));}}catch{}
  render();
}
initialize();
