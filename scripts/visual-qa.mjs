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
  const selectors='.topbar,.nav,.top-actions,.admin-main,.command-strip,.stats,.panel,.settings-shell,.settings-nav,.settings-category,.mode-grid,.zones-layout,.accounts-layout,.leaflet-map,.bottom-nav';
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
  await evaluate(`document.querySelector('[data-tab="settings"]').click()`);await sleep(800);
  for (const tab of ['session','gameplay','zones','safety','features','accounts']) {
    await evaluate(`document.querySelector('[data-settings-tab="${tab}"]').click()`);await sleep(tab==='zones'?1200:450);
    if (['gameplay','zones','accounts'].includes(tab)) await screenshot(`admin-${tab}-desktop`);
    results.push({name:`admin-${tab}-desktop`,...(await inspect())});
  }
  await viewport(390, 844, true);await evaluate(`document.querySelector('[data-settings-tab="gameplay"]').click()`);await sleep(600);await screenshot('admin-gameplay-mobile');results.push({name:'admin-gameplay-mobile',...(await inspect())});

  const adminAuth = await (await fetch(`${base}/api/auth/admin`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ callsign:'GAME-MASTER', password:'2468' }) })).json();
  const accountResponse = await fetch(`${base}/api/staff`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${adminAuth.token}`}, body:JSON.stringify({gameId:adminAuth.gameId,username:'qa-dowodca',callsign:'QA-ALFA',password:'Bezpieczne123',title:'Dowódca testowy',team:'ALL',permissions:['VIEW_ALL_PLAYERS','VIEW_FOV','VIEW_EVENTS','VIEW_SOS','SEND_ALL_MESSAGES','SEND_TEAM_MESSAGES','SEND_DIRECT_MESSAGES','RECEIVE_PLAYER_MESSAGES','MANAGE_PARTICIPANTS','MANAGE_OBJECTIVES','ACK_SOS']}) });
  if (!accountResponse.ok && accountResponse.status !== 409) throw new Error(`Nie utworzono konta QA: ${accountResponse.status}`);
  await viewport(1440, 1000);await navigate(`${base}/staff.html`);
  await evaluate(`(async()=>{const r=await fetch('/api/auth/staff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'WILK24',username:'qa-dowodca',password:'Bezpieczne123'})});const x=await r.json();sessionStorage.setItem('fm-staff','ok');sessionStorage.setItem('fm-staff-token',x.token);return true})()`);
  await call('Page.reload');
  await sleep(1800);await screenshot('staff-overview-desktop');results.push({name:'staff-overview-desktop',...(await inspect())});
  await evaluate(`document.querySelector('[data-staff-tab="map"]').click()`);await sleep(1200);await screenshot('staff-map-desktop');results.push({name:'staff-map-desktop',...(await inspect())});
  await viewport(390, 844, true);await evaluate(`document.querySelector('[data-staff-tab="messages"]').click()`);await sleep(600);await screenshot('staff-messages-mobile');results.push({name:'staff-messages-mobile',...(await inspect())});

  await viewport(390, 844, true);await navigate(`${base}/?demo=1&view=player&callsign=RAVEN`);await sleep(900);
  await evaluate(`document.querySelector('[data-player-tab="map"]').click()`);await sleep(900);await evaluate(`document.querySelector('[data-action="sos-open"]').click()`);await sleep(350);await screenshot('player-map-sos-mobile');
  const sosLayers = await evaluate(`(()=>{const modal=document.querySelector('.modal-backdrop'),map=document.querySelector('.leaflet-map');return{modal:Boolean(modal),map:Boolean(map),modalZ:modal?getComputedStyle(modal).zIndex:null,mapZ:map?getComputedStyle(map).zIndex:null,modalCoversMap:modal&&map?(()=>{const a=modal.getBoundingClientRect(),b=map.getBoundingClientRect();return a.left<=b.left&&a.right>=b.right&&a.top<=b.top&&a.bottom>=b.bottom})():false}})()`);
  results.push({name:'player-map-sos-mobile',...(await inspect()),sosLayers});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  const failures = results.filter(item => item.bodyWidth > item.width + 2 || item.overflow.length || item.panelOverlaps.length || item.errors.length || (item.sosLayers && (!item.sosLayers.modalCoversMap || Number(item.sosLayers.modalZ) <= Number(item.sosLayers.mapZ))));
  console.log(JSON.stringify({screenshots:output,checks:results.length,failures},null,2));
  if (failures.length) process.exitCode = 1;
} finally {
  ws.close();child.kill();appChild?.kill();
}
