import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.QA_BASE || 'http://127.0.0.1:18090';
const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 20000 + Math.floor(Math.random() * 20000);
const output = path.resolve('artifacts/visual-qa');
await fs.mkdir(output, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let appChild = null;
try { if (!(await fetch(`${base}/api/health`)).ok) throw new Error(); }
catch {
  const appPort = new URL(base).port || '18090';
  appChild = spawn(process.execPath, ['server/index.js'], { cwd:process.cwd(), env:{...process.env,PORT:appPort,NODE_ENV:'development',ADMIN_PASSWORD:'2468'}, stdio:'ignore', windowsHide:true });
  for(let i=0;i<40;i+=1){try{if((await fetch(`${base}/api/health`)).ok)break;}catch{}await sleep(150);}
}

const child = spawn(edge, [
  '--headless', '--hide-scrollbars', '--no-first-run', '--no-sandbox', '--remote-allow-origins=*',
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), `fieldmaster-qa-${Date.now()}`)}`,
  'about:blank'
], { stdio: 'ignore', windowsHide: true });

let target;
for (let i = 0; i < 60; i += 1) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item=>item.type==='page'&&item.url==='about:blank'); if (target?.webSocketDebuggerUrl) break; } catch {}
  await sleep(150);
}
if (!target?.webSocketDebuggerUrl) throw new Error('Nie uruchomiono testowej przeglądarki Edge.');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once:true }); ws.addEventListener('error', reject, { once:true }); });
let id = 0;
const waiting = new Map();
ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id && waiting.has(message.id)) { const { resolve, reject } = waiting.get(message.id); waiting.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); } });
ws.addEventListener('close', () => { for (const { reject } of waiting.values()) reject(new Error('Przeglądarka zamknęła połączenie CDP.')); waiting.clear(); });
const call = (method, params = {}) => new Promise((resolve, reject) => { const callId = ++id; const timeout=setTimeout(()=>{waiting.delete(callId);reject(new Error(`CDP timeout: ${method}`));},30000);waiting.set(callId,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});ws.send(JSON.stringify({ id: callId, method, params })); });
const evaluate = async expression => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
const navigate = async url => { await call('Page.navigate', { url }); await sleep(1400); };
const viewport = (width, height, mobile = false) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
const screenshot = async name => { const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64')); };
const inspect = () => evaluate(`(() => {
  const selectors='.topbar,.nav,.top-actions,.admin-main,.command-strip,.stats,.panel,.settings-shell,.settings-nav,.settings-category,.mode-grid,.zones-layout,.accounts-layout,.participants-console,.participant-filters,.time-settings-grid,.knowledge-base,.operations-console,.operations-grid,.preset-grid,.archive-list,.leaflet-map,.bottom-nav';
  const visible=[...document.querySelectorAll(selectors)].filter(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0});
  const overflow=visible.filter(el=>{const r=el.getBoundingClientRect();return r.left < -2 || r.right > innerWidth+2}).map(el=>({tag:el.tagName,class:el.className,left:Math.round(el.getBoundingClientRect().left),right:Math.round(el.getBoundingClientRect().right)}));
  const panels=[...document.querySelectorAll('.panel')].filter(el=>el.getBoundingClientRect().width>0);const overlaps=[];
  for(let i=0;i<panels.length;i++)for(let j=i+1;j<panels.length;j++){const a=panels[i],b=panels[j];if(a.contains(b)||b.contains(a))continue;const x=a.getBoundingClientRect(),y=b.getBoundingClientRect(),w=Math.min(x.right,y.right)-Math.max(x.left,y.left),h=Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top);if(w>3&&h>3)overlaps.push([a.className,b.className,Math.round(w*h)]);}
  return {url:location.pathname+location.search,width:innerWidth,bodyWidth:document.body.scrollWidth,overflow,panelOverlaps:overlaps,errors:window.__qaErrors||[]};
})()`);

await call('Page.enable');await call('Runtime.enable');
await call('Runtime.evaluate', { expression: `window.__qaErrors=[];window.addEventListener('error',e=>window.__qaErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__qaErrors.push(String(e.reason)))` });
const results = [];
try {
  await viewport(1440, 1000);
  await navigate(`${base}/admin.html`);
  await evaluate(`(async()=>{const r=await fetch('/api/auth/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callsign:'GAME-MASTER',password:'2468'})});const x=await r.json();sessionStorage.setItem('fm-admin','ok');sessionStorage.setItem('fm-admin-token',x.token);return true})()`);
  await call('Page.reload');
  await sleep(1800);
  await screenshot('admin-dashboard-desktop');results.push({name:'admin-dashboard-desktop',...(await inspect())});
  const participantSetup=await evaluate(`(async()=>{const adminToken=sessionStorage.getItem('fm-admin-token'),gameId=document.querySelector('#admin-session')?.value,join=await fetch('/api/games/WILK24/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callsign:'PANEL-QA',team:'SERE',consent:true,consentVersion:'qa'})}),joined=await join.json();if(!join.ok)return{ok:false,error:joined.error};await fetch('/api/participants/'+joined.participant.id,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer '+adminToken},body:JSON.stringify({mapAccess:false})});localStorage.setItem('qa-player-token',joined.token);localStorage.setItem('qa-player-id',joined.participant.id);localStorage.setItem('fm-player-token',joined.token);localStorage.setItem('fieldmaster-player-id',joined.participant.id);return{ok:true,id:joined.participant.id,gameId}})()`);await sleep(700);
  await evaluate(`document.querySelector('[data-tab="participants"]').click()`);await sleep(500);await evaluate(`document.querySelector('.participant-record summary')?.click()`);await sleep(250);await screenshot('admin-participants-desktop');
  const participantEditor=await evaluate(`(()=>({setup:${JSON.stringify(participantSetup)},filters:document.querySelectorAll('.participant-filters input,.participant-filters select').length,records:document.querySelectorAll('.participant-record').length,mapToggle:document.querySelector('[id^="map-access-"]')?.checked,respawnButton:Boolean(document.querySelector('[data-action="participant-respawn"]')),clearButton:Boolean(document.querySelector('[data-action="participant-clear"]'))}))()`);
  results.push({name:'admin-participants-desktop',...(await inspect()),participantEditor});
  await viewport(390,844,true);await screenshot('admin-participants-mobile');results.push({name:'admin-participants-mobile',...(await inspect())});
  await viewport(1440,1000);await evaluate(`document.querySelector('[data-tab="teams"]').click()`);await sleep(600);await screenshot('admin-teams-roles-desktop');
  const teamsRoles=await evaluate(`(()=>({teams:document.querySelectorAll('.operation-card [data-action="team-save"]').length,roles:document.querySelectorAll('.operation-card [data-action="role-save"]').length,teamCreate:Boolean(document.querySelector('#team-create-form')),roleCreate:Boolean(document.querySelector('#role-create-form')),capabilities:document.querySelectorAll('[data-role-capability]').length}))()`);results.push({name:'admin-teams-roles-desktop',...(await inspect()),teamsRoles});
  await viewport(390,844,true);await screenshot('admin-teams-roles-mobile');results.push({name:'admin-teams-roles-mobile',...(await inspect())});
  await viewport(390,844,true);await navigate(`${base}/?view=player`);await sleep(1500);
  const playerMapLock=await evaluate(`(()=>({status:Boolean(document.querySelector('[data-player-tab="status"]')),mapButton:Boolean(document.querySelector('[data-player-tab="map"]')),callsign:document.querySelector('.player-callsign')?.textContent}))()`);await screenshot('player-map-locked-mobile');results.push({name:'player-map-locked-mobile',...(await inspect()),playerMapLock});
  await viewport(1440,1000);await navigate(`${base}/admin.html`);await sleep(1200);
  await evaluate(`document.querySelector('[data-tab="settings"]').click()`);await sleep(800);
  for (const tab of ['session','presets','gameplay','zones','safety','features','accounts']) {
    await evaluate(`document.querySelector('[data-settings-tab="${tab}"]').click()`);await sleep(tab==='zones'?1200:450);
    if (['gameplay','zones','accounts'].includes(tab)) await screenshot(`admin-${tab}-desktop`);
    results.push({name:`admin-${tab}-desktop`,...(await inspect())});
    if(tab==='session'){
      await screenshot('admin-session-times-desktop');
      const sessionTimes=await evaluate(`(()=>({game:Boolean(document.querySelector('#game-duration')),respawn:Boolean(document.querySelector('#respawn-seconds-session')),sere:Boolean(document.querySelector('#sere-timer-seconds')),opfor:Boolean(document.querySelector('#opfor-timer-seconds')),duplicateRespawn:Boolean(document.querySelector('#respawn-seconds'))}))()`);
      results.push({name:'admin-session-times-desktop',...(await inspect()),sessionTimes});
    }
    if(tab==='presets'){
      await screenshot('admin-presets-desktop');
      const presetView=await evaluate(`(()=>({cards:document.querySelectorAll('.preset-card').length,apply:document.querySelectorAll('[data-action="preset-apply"]').length}))()`);
      results.push({name:'admin-presets-desktop',...(await inspect()),presetView});
    }
    if(tab==='zones'){
      await evaluate(`document.querySelector('[data-action="zone-new"]').click()`);await sleep(650);await screenshot('admin-zone-editor-desktop');
      const zoneEditor=await evaluate(`(()=>({selected:Boolean(document.querySelector('.zone-select.active')),handles:document.querySelectorAll('.zone-point-handle').length,shape:document.querySelector('#zone-shape')?.value}))()`);
      results.push({name:'admin-zone-editor-desktop',...(await inspect()),zoneEditor});
    }
  }
  await evaluate(`document.querySelector('[data-settings-tab="gameplay"]').click()`);await sleep(350);await evaluate(`document.querySelector('input[name="game-mode"][value="DOMINATION"]').click()`);await sleep(350);await screenshot('admin-gameplay-selected-desktop');
  const modeSelection=await evaluate(`(()=>({current:document.querySelector('.mode-card.current b')?.textContent,selected:document.querySelector('.mode-card.selected b')?.textContent,selectedCurrent:document.querySelector('.mode-card.selected')?.classList.contains('current')}))()`);
  results.push({name:'admin-gameplay-selected-desktop',...(await inspect()),modeSelection});
  await viewport(390, 844, true);await evaluate(`document.querySelector('[data-settings-tab="gameplay"]').click()`);await sleep(600);await screenshot('admin-gameplay-mobile');results.push({name:'admin-gameplay-mobile',...(await inspect())});
  await viewport(1440,1000);await evaluate(`document.querySelector('[data-tab="help"]').click()`);await sleep(500);await screenshot('admin-information-desktop');
  const knowledge=await evaluate(`(()=>({modes:document.querySelectorAll('.knowledge-list details').length,features:document.querySelectorAll('.feature-help article').length,zones:document.querySelectorAll('.zone-info-grid article').length}))()`);results.push({name:'admin-information-desktop',...(await inspect()),knowledge});

  await viewport(1440,1000);await evaluate(`document.querySelector('[data-tab="settings"]').click()`);await sleep(250);await evaluate(`document.querySelector('[data-settings-tab="accounts"]').click()`);await sleep(450);
  await evaluate(`(()=>{const values={'#staff-username':'qa-dowodca','#staff-callsign':'QA-ALFA','#staff-password':'Bezpieczne123','#staff-title':'Dowódca testowy'};for(const [selector,value] of Object.entries(values)){const input=document.querySelector(selector);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('#staff-create-form').requestSubmit();return true})()`);await sleep(1600);await evaluate(`scrollTo(0,0)`);await screenshot('admin-account-existing-desktop');
  const accountEditor=await evaluate(`(async()=>{const gameId=document.querySelector('#admin-session')?.value,token=sessionStorage.getItem('fm-admin-token'),headers={Authorization:'Bearer '+token},response=await fetch('/api/staff?gameId='+encodeURIComponent(gameId),{headers}),accounts=await response.json(),games=await(await fetch('/api/games',{headers})).json(),allCounts={};for(const game of games)allCounts[game.id]=(await(await fetch('/api/staff?gameId='+encodeURIComponent(game.id),{headers})).json()).length;return{accounts:document.querySelectorAll('.staff-account').length,editable:Boolean(document.querySelector('[id^="staff-callsign-"]')),deleteButton:Boolean(document.querySelector('[data-action="staff-delete"]')),newPreset:Boolean(document.querySelector('#new-permission-preset')),accountPreset:Boolean(document.querySelector('[data-account-preset]')),apiCount:accounts.length,gameId,allCounts}})()`);
  results.push({name:'admin-account-existing-desktop',...(await inspect()),accountEditor});
  await viewport(1440, 1000);await navigate(`${base}/staff.html`);
  await evaluate(`(async()=>{const r=await fetch('/api/auth/staff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'WILK24',username:'qa-dowodca',password:'Bezpieczne123'})});const x=await r.json();sessionStorage.setItem('fm-staff','ok');sessionStorage.setItem('fm-staff-token',x.token);return true})()`);
  await call('Page.reload');
  await sleep(1800);await screenshot('staff-overview-desktop');results.push({name:'staff-overview-desktop',...(await inspect())});
  await evaluate(`document.querySelector('[data-staff-tab="map"]').click()`);await sleep(1200);await screenshot('staff-map-desktop');results.push({name:'staff-map-desktop',...(await inspect())});
  await viewport(390, 844, true);await evaluate(`document.querySelector('[data-staff-tab="messages"]').click()`);await sleep(600);await screenshot('staff-messages-mobile');results.push({name:'staff-messages-mobile',...(await inspect())});

  await viewport(390, 844, true);await navigate(`${base}/?demo=1&view=player&callsign=RAVEN&team=OPFOR`);await evaluate(`localStorage.removeItem('fm-player-token');localStorage.removeItem('fieldmaster-player-id')`);await call('Page.reload');await sleep(900);
  await evaluate(`document.querySelector('[data-player-tab="map"]').click()`);await sleep(900);await evaluate(`document.querySelector('[data-action="sos-open"]').click()`);await sleep(350);await screenshot('player-map-sos-mobile');
  const sosLayers = await evaluate(`(()=>{const modal=document.querySelector('.modal-backdrop'),map=document.querySelector('.leaflet-map');return{modal:Boolean(modal),map:Boolean(map),modalZ:modal?getComputedStyle(modal).zIndex:null,mapZ:map?getComputedStyle(map).zIndex:null,modalCoversMap:modal&&map?(()=>{const a=modal.getBoundingClientRect(),b=map.getBoundingClientRect();return a.left<=b.left&&a.right>=b.right&&a.top<=b.top&&a.bottom>=b.bottom})():false}})()`);
  results.push({name:'player-map-sos-mobile',...(await inspect()),sosLayers});
  await viewport(1440,1000);await navigate(`${base}/admin.html`);await sleep(1200);
  await evaluate(`(async()=>{const adminToken=sessionStorage.getItem('fm-admin-token'),gameId=document.querySelector('#admin-session')?.value,playerToken=localStorage.getItem('qa-player-token'),playerId=localStorage.getItem('qa-player-id'),zone={id:crypto.randomUUID(),name:'Most testowy',type:'BOMB_SITE',team:'SERE',shape:'CIRCLE',center:[52.2304,21.0184],radius:300,color:'#ff493d',bombState:'IDLE'};await fetch('/api/participants/'+playerId,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer '+adminToken},body:JSON.stringify({mapAccess:true})});await fetch('/api/games/'+gameId+'/settings',{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer '+adminToken},body:JSON.stringify({mode:'BOMB_DEFUSAL',modeSettings:{modeRules:{plantSeconds:1,defuseSeconds:1,bombTimerSeconds:30}}})});await fetch('/api/games/'+gameId+'/zones',{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer '+adminToken},body:JSON.stringify({zones:[zone]})});await fetch('/api/games/'+gameId+'/start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+adminToken},body:'{}'});for(const [i,point] of [[52.2304,21.0184],[52.2308,21.0190],[52.2312,21.0198]].entries())await fetch('/api/locations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+playerToken},body:JSON.stringify({latitude:point[0],longitude:point[1],accuracy:4,heading:45,headingSource:'COMPASS',timestamp:new Date(Date.now()+i*6000).toISOString()})});localStorage.setItem('fm-player-token',playerToken);localStorage.setItem('fieldmaster-player-id',playerId);return true})()`);await sleep(900);
  await viewport(390,844,true);await navigate(`${base}/?view=player`);await sleep(1400);await screenshot('player-bomb-action-mobile');
  const bombAction=await evaluate(`(()=>({button:[...document.querySelectorAll('[data-action="zone-interact"]')].some(button=>button.textContent.includes('Podłóż bombę')),mode:document.querySelector('.mode-intel .eyebrow')?.textContent}))()`);results.push({name:'player-bomb-action-mobile',...(await inspect()),bombAction});
  await viewport(1440,1000);await navigate(`${base}/admin.html`);await sleep(1200);
  await evaluate(`document.querySelector('[data-tab="report"]').click()`);await sleep(500);await evaluate(`document.querySelector('[data-action="archive-create"]')?.click()`);await sleep(900);await screenshot('admin-archive-desktop');
  const archiveView=await evaluate(`(()=>({items:document.querySelectorAll('.archive-list article').length,download:Boolean(document.querySelector('[data-action="archive-download"]')),remove:Boolean(document.querySelector('[data-action="archive-delete"]'))}))()`);results.push({name:'admin-archive-desktop',...(await inspect()),archiveView});
  await evaluate(`document.querySelector('[data-action="replay-load"]')?.click()`);await sleep(1300);await screenshot('admin-replay-desktop');
  const replayView=await evaluate(`(()=>({map:Boolean(document.querySelector('.replay-panel .leaflet-map')),range:Boolean(document.querySelector('#replay-range')),legend:document.querySelectorAll('.replay-legend span').length,play:Boolean(document.querySelector('[data-action="replay-play"]'))}))()`);
  results.push({name:'admin-replay-desktop',...(await inspect()),replayView});
  await evaluate(`document.querySelector('[data-action="replay-delete"]')?.click()`);await sleep(300);await screenshot('admin-replay-delete-confirm');
  const replayDelete=await evaluate(`(()=>({modal:Boolean(document.querySelector('[data-confirm-replay-delete]')),warning:document.querySelector('.modal.danger p')?.textContent.includes('trwale')}))()`);results.push({name:'admin-replay-delete-confirm',...(await inspect()),replayDelete});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  const failures = results.filter(item => item.bodyWidth > item.width + 2 || item.overflow.length || item.panelOverlaps.length || item.errors.length || (item.sosLayers && (!item.sosLayers.modalCoversMap || Number(item.sosLayers.modalZ) <= Number(item.sosLayers.mapZ))) || (item.zoneEditor && (!item.zoneEditor.selected || item.zoneEditor.handles < 3)) || (item.modeSelection && (item.modeSelection.current===item.modeSelection.selected || item.modeSelection.selectedCurrent)) || (item.accountEditor && (!item.accountEditor.accounts || !item.accountEditor.editable || !item.accountEditor.deleteButton || !item.accountEditor.newPreset || !item.accountEditor.accountPreset)) || (item.participantEditor && (!item.participantEditor.setup?.ok || item.participantEditor.filters < 3 || item.participantEditor.records < 1 || item.participantEditor.mapToggle !== false || !item.participantEditor.respawnButton || !item.participantEditor.clearButton)) || (item.teamsRoles && (item.teamsRoles.teams < 2 || item.teamsRoles.roles < 8 || !item.teamsRoles.teamCreate || !item.teamsRoles.roleCreate || item.teamsRoles.capabilities < 20)) || (item.presetView && (item.presetView.cards < 6 || item.presetView.apply < 6)) || (item.archiveView && (item.archiveView.items < 1 || !item.archiveView.download || !item.archiveView.remove)) || (item.playerMapLock && (!item.playerMapLock.status || item.playerMapLock.mapButton || item.playerMapLock.callsign!=='PANEL-QA')) || (item.sessionTimes && (!item.sessionTimes.game || !item.sessionTimes.respawn || !item.sessionTimes.sere || !item.sessionTimes.opfor || item.sessionTimes.duplicateRespawn)) || (item.knowledge && (item.knowledge.modes < 12 || item.knowledge.features < 40 || item.knowledge.zones < 10)) || (item.bombAction && (!item.bombAction.button || !item.bombAction.mode?.includes('Podłożenie'))) || (item.replayView && (!item.replayView.map || !item.replayView.range || !item.replayView.play || item.replayView.legend < 1)) || (item.replayDelete && (!item.replayDelete.modal || !item.replayDelete.warning)));
  console.log(JSON.stringify({screenshots:output,checks:results.length,failures},null,2));
  if (failures.length) process.exitCode = 1;
} finally {
  ws.close();child.kill();appChild?.kill();
}
