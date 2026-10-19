/**
 * Captures the screenshots used by docs/user-guide/guide.html from a running copy of the app.
 *   npx vite build --outDir <dir> && npx vite preview --outDir <dir> --port 4610 --host 127.0.0.1
 *   node scripts/guide-shots.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/user-guide/assets');
const BASE = process.argv[2] || 'http://127.0.0.1:4610';
const CHROME = process.env.CHROME_PATH || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = n => !ONLY || ONLY.includes(n);
const NAMES = process.env.NAMES ? process.env.NAMES.split(',') : null;   // limit the 'modules' part to some images

const b = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true, args: ['--no-sandbox', '--disable-gpu', '--no-first-run'], timeout: 30000 });
const p = await b.newPage();
p.setDefaultTimeout(15000);

async function fresh(w = 1100, h = 760, mobile = false) {
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('or_theme', 'light'); });
}
async function open(mod, lib, query = '') {
  await p.goto(`${BASE}/#/m/${mod}?lib=${lib}${query}`, { waitUntil: 'load' });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('section[aria-label=Solution]');
  await sleep(1200);
}
const key = async k => { await p.keyboard.press(k); await sleep(250); };
async function tab(name) {
  const ok = await p.evaluate(n => { const t = [...document.querySelectorAll('[role=tab]')].find(x => x.textContent.trim() === n); if (t) { t.click(); return true; } return false; }, name);
  if (!ok) throw new Error('no tab ' + name);
  await sleep(700);
}
async function snap(name, clip, opt = {}) {
  await sleep(opt.wait ?? 2500);   // charts animate in; the screenshot lags one frame
  const sy = await p.evaluate(() => window.scrollY);
  await p.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: opt.q ?? 80, clip: { ...clip, y: clip.y + sy } });
  console.log('shot', name);
}
const rect = sel => p.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
/** clip of the Solution section, scrolled to the top of the viewport */
async function solution(name, h = 620, opt = {}) {
  await p.evaluate(keep => { let st = document.getElementById('guide-css'); if (!st) { st = document.createElement('style'); st.id = 'guide-css'; document.head.appendChild(st); } st.textContent = keep ? '' : '.nb-reason{display:none!important}'; }, !!opt.keepReason);
  await p.evaluate(() => { const s = document.querySelector('section[aria-label=Solution]'); window.scrollTo(0, window.scrollY + s.getBoundingClientRect().top - 66); });
  await sleep(300);
  const vp = p.viewport();
  const top = await p.evaluate(() => document.querySelector('section[aria-label=Solution]').getBoundingClientRect().top);   // the page may be too short to scroll the section to the top
  const y = Math.max(60, top - 4);
  await snap(name, { x: opt.x ?? 84, y, width: vp.width - (opt.x ?? 84) - 8, height: Math.min(h, vp.height - y - 76) }, opt);
}
async function model(name, h = 420) {
  await p.evaluate(() => { const st = document.getElementById('guide-css'); if (st) st.textContent = ''; });
  await p.evaluate(() => { const s = document.querySelector('section[aria-label=Model]'); window.scrollTo(0, window.scrollY + s.getBoundingClientRect().top - 66); });
  await sleep(300);
  const vp = p.viewport();
  const top = await p.evaluate(() => document.querySelector('section[aria-label=Model]').getBoundingClientRect().top);
  const y = Math.max(60, top - 4);
  await snap(name, { x: 84, y, width: vp.width - 92, height: Math.min(h, vp.height - y - 76) });
}

if (want('overview')) {
/* ---------- overview of the workspace, with positions of the parts for the numbered markers ---------- */
await fresh(1180, 1060);
await open('lp', 'lp-reddy');
await p.evaluate(() => { const st = document.createElement('style'); st.textContent = 'textarea{height:96px!important;min-height:0!important}'; document.head.appendChild(st); });
await key('ArrowRight'); await key('ArrowRight');
await p.evaluate(() => window.scrollTo(0, 0));
await sleep(500);
const W = 1180, H = 1060;
const find = async (sel) => rect(sel);
const labelRect = async (aria) => rect(`[aria-label="${aria}"]`);
const m = {};
m.titleblock = await rect('.titleblock');
m.method = await labelRect('Method');
m.mode = await labelRect('Mode');
m.actions = await labelRect('Actions');
m.model = await rect('section[aria-label=Model] .nb-h');
m.hide = await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /Hide/.test(x.textContent)); const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
m.solution = await rect('section[aria-label=Solution] .nb-h');
m.status = await p.evaluate(() => { let best = null; for (const e of document.querySelectorAll('section[aria-label=Solution] div')) { if (/^\s*OPTIMAL/i.test(e.textContent) && e.getBoundingClientRect().height < 80 && e.getBoundingClientRect().height > 20) { best = e; break; } } if (!best) return null; const r = best.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
m.tabs = await labelRect('Views');
m.player = await labelRect('Step player');
m.speed = await labelRect('Playback speed');
m.present = await rect('[aria-label^="Presentation mode"]');
m.explanation = await rect('section[aria-label="Step explanation"]');
await snap('ws-overview', { x: 0, y: 0, width: W, height: H });
fs.writeFileSync(path.join(OUT, 'ws-marks.json'), JSON.stringify({ W, H, ...m }, null, 1));
m.explanation = await rect('section[aria-label="Step explanation"]');
fs.writeFileSync(path.join(OUT, 'ws-marks.json'), JSON.stringify({ W, H, ...m }, null, 1));


}
if (want('hub')) {
/* ---------- hub, library, docs ---------- */
await fresh(1280, 900);
await p.goto(BASE + '/#/', { waitUntil: 'load' }); await p.reload({ waitUntil: 'load' }); await sleep(1200);
await snap('hub', { x: 0, y: 0, width: 1280, height: 900 }, { q: 78 });
await p.goto(BASE + '/#/library', { waitUntil: 'load' }); await sleep(1200);
await snap('library', { x: 0, y: 0, width: 1280, height: 900 }, { q: 78 });


}
if (want('tutor')) {
/* ---------- tutor, palette, tooltip, save, export, form, presentation ---------- */
await fresh(1100, 760);
await open('lp', 'lp-reddy');
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Tutor').click());
await sleep(800);
await p.evaluate(() => { const b = [...document.querySelectorAll('[aria-label="Answer choices"] button')].find(x => x.textContent.trim() === 'x₂'); b.click(); });
await sleep(600);
await p.evaluate(() => { const c = [...document.querySelectorAll('.card')].find(x => /Tutor mode/.test(x.textContent) && x.querySelector('[aria-label="Answer choices"]')); c.scrollIntoView({ block: 'center' }); });
await sleep(400);
{ const r = await p.evaluate(() => { const c = [...document.querySelectorAll('.card')].filter(x => /Tutor mode/.test(x.textContent) && x.querySelector('[aria-label="Answer choices"]')).pop(); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await snap('tutor', { x: r.x - 8, y: Math.max(0, r.y - 8), width: r.w + 16, height: Math.min(r.h + 16, 700 - r.y) }); }


}
if (want('palette')) {
await fresh(1100, 760); await open('lp', 'lp-reddy');
await p.keyboard.press('/'); await sleep(400); await p.keyboard.type('sim', { delay: 40 }); await sleep(600);
{ const r = await rect('[data-palette]'); await snap('palette', { x: r.x - 12, y: r.y - 12, width: r.w + 24, height: r.h + 24 }); }
await p.keyboard.press('Escape');


}
if (want('tooltip')) {
await fresh(1100, 760); await open('lp', 'lp-reddy');
await p.evaluate(() => { const t = document.querySelector('section[aria-label=Solution]'); window.scrollTo(0, window.scrollY + t.getBoundingClientRect().top - 66); });
await sleep(400);
{ const pos = await p.evaluate(() => { const e = [...document.querySelectorAll('th[data-term]')].find(x => x.textContent.trim() === 'Ratio') || document.querySelector('th[data-term]'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await p.mouse.move(pos.x - 30, pos.y - 30); await sleep(200); await p.mouse.move(pos.x, pos.y, { steps: 4 }); await p.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); for (const t of ['mouseover', 'mouseenter', 'mousemove']) e.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y })); }, pos); await sleep(1200);
  const tip = await rect('#glossary-tip');
  const x0 = Math.max(0, Math.min(1100 - 620, pos.x - 300, tip ? tip.x - 20 : pos.x - 300)); const y0 = Math.max(0, pos.y - 80);
  const f = path.join(OUT, 'tooltip.jpg');
  await p.screenshot({ path: f, type: 'jpeg', quality: 80 });   // the tip hides itself on scroll, so crop the whole viewport instead of clipping
  const cw = 620, ch = Math.min(330, 760 - y0);
  execFileSync('sips', ['-c', String(ch * 2), String(cw * 2), '--cropOffset', String(Math.round(y0 * 2)), String(Math.round(x0 * 2)), f], { stdio: 'ignore' });
  console.log('shot tooltip');
}


}
if (want('savexport')) {
await fresh(1100, 760); await open('lp', 'lp-reddy');
await p.click('[aria-label="Save model…"]'); await sleep(600);
{ const r = await rect('[role=dialog]'); await snap('save-dialog', { x: r.x - 10, y: r.y - 10, width: r.w + 20, height: r.h + 20 }); }
await p.keyboard.press('Escape'); await sleep(300);
await p.click('[aria-label="Export…"]'); await sleep(600);
{ const r = await rect('[role=menu]'); const a = await rect('[aria-label="Actions"]'); const x0 = Math.max(0, r.x - 360); await snap('export-menu', { x: x0, y: a.y - 12, width: Math.min(1100 - x0, r.w + 372), height: r.y + r.h - a.y + 24 }); }
await p.keyboard.press('Escape');


}
if (want('form')) {
await fresh(1100, 760); await open('lp', 'lp-reddy');
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Form').click()); await sleep(800);
await model('lp-form', 560);
await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Text').click()); await sleep(500);
// an error message
await p.evaluate(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'max 5x1 + 4x2\nsubject to\n  6x1 + 4x2 <= \n  x1 + 2x2 <= 6'); t.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(900);
{ const r = await rect('textarea'); const e = await rect('#lp-text-status'); await snap('lp-error', { x: r.x - 8, y: r.y - 8, width: r.w + 16, height: e.y + e.h - r.y + 16 }); }


}
if (want('present')) {
await fresh(1100, 760); await open('lp', 'lp-reddy');
await key('p'); await sleep(800);
await p.evaluate(() => window.scrollTo(0, 0)); await sleep(300);
await snap('presentation', { x: 0, y: 0, width: 1100, height: 760 }, { q: 78 });


}
if (want('phone')) {
/* ---------- phone ---------- */
await fresh(390, 844, true);
await open('lp', 'lp-reddy');
await sleep(500);
await snap('phone', { x: 0, y: 0, width: 390, height: 844 });
await p.click('[aria-label="Open menu"]'); await sleep(700);
await snap('phone-menu', { x: 0, y: 0, width: 390, height: 844 });


}
if (want('modules')) {
/* ---------- one shot per module (+ extras) ---------- */
await fresh(1200, 900);
const MOD = [
  ['lp', 'lp-reddy', null, 'm-lp', 700, { end: true }],
  ['lp', 'lp-reddy', 'Graphical', 'lp-graph', 760, { end: true }],
  ['integer', 'int-taha', null, 'm-integer', 720, { end: true }],
  ['nlp', 'nlp-bowl', null, 'm-nlp', 560, { end: true }],
  ['transport', 'tr-taha', null, 'm-transport', 640, { end: true }],
  ['assign', 'as-4x4', null, 'm-assign', 560, { end: true }],
  ['network', 'net-short', null, 'm-network', 600, { end: true }],
  ['project', 'pr-cpm', null, 'm-project', 560, { end: true }],
  ['queuing', 'q-mm1', null, 'm-queuing', 600, {}],
  ['inventory', 'inv-eoq', null, 'm-inventory', 600, {}],
  ['games', 'g-dom', null, 'm-games', 640, { end: true }],
  ['markov', 'mk-weather', null, 'm-markov', 620, {}],
  ['simulation', 'sim-exp10-demand', 'Simulation table', 'm-simulation', 620, {}],
  ['sequencing', 'seq-exp10', 'Gantt', 'm-sequencing', 560, {}],
];
for (const [mod, lib, tb, name, h, o] of MOD) {
  if (NAMES && !NAMES.includes(name)) continue;
  await open(mod, lib);
  if (o.end) await key('End');
  if (tb) await tab(tb);
  await solution(name, h);
  await p.evaluate(() => window.scrollTo(0, 0));
  if (['transport', 'network', 'project', 'sequencing', 'games', 'queuing', 'inventory', 'markov'].includes(mod)) { await model('in-' + mod, 560); }
}
// LP extras
if (!NAMES) {
await open('lp', 'lp-reddy'); await key('End');
for (const [t, n] of [['Sensitivity', 'lp-sens'], ['Duality', 'lp-duality'], ['Basic solutions', 'lp-basic'], ['Primal–dual', 'lp-pd'], ['Diff mode', 'lp-diff']]) { await tab(t); await solution(n, 600); }
await open('integer', 'int-taha'); await key('End'); await tab('Plane'); await solution('int-plane', 560);
await open('project', 'pr-pert'); await key('End'); await tab('Gantt'); await solution('pr-gantt', 560);
await open('transport', 'tr-taha'); await key('End'); await tab('Method comparison'); await solution('tr-compare', 560);
await open('simulation', 'sim-pi'); await solution('sim-mc', 600);
await open('simulation', 'sim-inv-sS'); await tab('Day table'); await solution('sim-inv', 640);
await open('simulation', 'sim-rng-lcg'); await solution('sim-rng', 640);
await open('simulation', 'sim-exp10-demand'); await model('in-simulation', 700); await tab('Walkthrough'); await key('End'); await solution('sim-walk', 640);
await open('sequencing', 'seq-exp10'); await tab('Sequence'); await solution('seq-seq', 560);
await open('network', 'net-flow'); await key('End'); await solution('net-flow', 620);
await open('queuing', 'q-cost'); await tab('Cost model'); await solution('q-cost', 640);
await open('inventory', 'inv-news'); await solution('inv-news', 640);
await open('games', 'g-2xn'); await key('End'); await solution('g-2xn', 640);
await open('markov', 'mk-abs'); await solution('mk-abs', 640);
await open('nlp', 'nlp-kkt'); await solution('nlp-kkt', 500); await model('in-nlp', 620);
await open('integer', 'int-taha'); await tab('Tree'); await model('in-integer', 520);
await open('assign', 'as-4x4'); await model('in-assign', 480);
}

}
await fs.writeFileSync(path.join(OUT, '.done'), '1');
await b.close();
