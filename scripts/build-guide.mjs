/**
 * Builds the OR/Studio user guide PDF.
 *   npm run guide
 * Reads docs/user-guide/guide.html (+ guide.css, assets/), fills in the fonts, the glossary and the
 * contents page numbers, prints it with a Chromium-family browser and writes public/OR-Studio-User-Guide.pdf.
 * Set CHROME_PATH to use another browser (default: Brave).
 */
import puppeteer from 'puppeteer-core';
import ts from 'typescript';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'docs/user-guide');
const OUT = path.join(ROOT, 'public/OR-Studio-User-Guide.pdf');
const BUILD_HTML = path.join(DIR, '.guide.build.html');
const BUILD_CSS = path.join(DIR, '.guide.build.css');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);
const exe = CANDIDATES.find(p => fs.existsSync(p));
if (!exe) { console.error('No Chromium-family browser found. Set CHROME_PATH.'); process.exit(1); }

/* ---------- fonts: Geist and Geist Mono, embedded from node_modules ---------- */
function fontCss(pkg, family) {
  const base = path.join(ROOT, 'node_modules/@fontsource-variable', pkg);
  const css = fs.readFileSync(path.join(base, 'wght.css'), 'utf8');
  return css.split('@font-face').slice(1)
    .filter(b => /-(latin|latin-ext)-wght-normal/.test(b))
    .map(b => '@font-face' + b.replace(/font-family:[^;]+;/, `font-family: '${family}';`)
      .replace(/url\(\.\/files\/([^)]+)\)/, (_, f) => `url("${pathToFileURL(path.join(base, 'files', f)).href}")`).replace(/\/\*[^]*$/, ''))
    .join('\n');
}
const fonts = fontCss('geist', 'Geist') + '\n' + fontCss('geist-mono', 'Geist Mono');

/* ---------- glossary: generated from src/lib/glossary.ts ---------- */
const gsrc = path.join(ROOT, 'src/lib/glossary.ts');
const gtext = fs.readFileSync(gsrc, 'utf8');
const js = ts.transpileModule(gtext, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const gmod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const entries = gmod.glossaryEntries();
// group names come from the section comments in the source file; terms keep their order
const body = gtext.slice(gtext.indexOf('const D: Record'), gtext.indexOf('/** Generated variables'));
const groupAt = [];
for (const m of body.matchAll(/\/\*\s*-+\s*(.+?)\s*-+\s*\*\//g)) groupAt.push({ pos: m.index, name: m[1] });
const termGroup = new Map();
for (const m of body.matchAll(/^ {2}'((?:[^'\\]|\\.)+)':\s*E\(/gm)) {
  const term = m[1].replace(/\\'/g, "'");
  const g = [...groupAt].reverse().find(x => x.pos < m.index);
  termGroup.set(term, g ? g.name : 'general');
}
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const groups = new Map();
for (const e of entries) {
  const g = termGroup.get(e.term) ?? 'general';
  if (!groups.has(g)) groups.set(g, new Map());
  const byTitle = groups.get(g);
  const key = e.title.toLowerCase() + '|' + (e.m ?? []).join(',');
  const cur = byTitle.get(key);
  if (cur) { if (!cur.terms.includes(e.term)) cur.terms.push(e.term); }
  else byTitle.set(key, { terms: [e.term], title: e.title, def: e.def, m: e.m });
}
const pretty = n => n.replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/ \/ /g, ' / ');
let glossaryHtml = '';
let glossaryCount = 0;
const cell = it => it
  ? `<th scope="row"><span class="term">${it.terms.map(esc).join(' / ')}</span>${it.m ? `<span class="tm">${esc(it.m.join(', '))}</span>` : ''}</th><td>${esc(it.def)}</td>`
  : '<th></th><td></td>';
for (const [g, map] of groups) {
  const items = [...map.values()];
  glossaryCount += items.length;
  const half = Math.ceil(items.length / 2);
  glossaryHtml += `<h3 class="gl-h">${esc(pretty(g))}</h3>\n<table class="t gl2"><colgroup><col style="width:11%"><col style="width:39%"><col style="width:11%"><col style="width:39%"></colgroup><tbody>\n`;
  for (let i = 0; i < half; i++) glossaryHtml += `<tr>${cell(items[i])}${cell(items[i + half])}</tr>\n`;
  glossaryHtml += '</tbody></table>\n';
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let html = fs.readFileSync(path.join(DIR, 'guide.html'), 'utf8');
html = html.replace('/*%%FONTS%%*/', fonts)
  .replace('<!--%%GLOSSARY%%-->', glossaryHtml)
  .replaceAll('%%VERSION%%', pkg.version)
  .replaceAll('%%GLOSSARY_COUNT%%', String(glossaryCount));
html = html.replace('href="guide.css"', 'href=".guide.build.css"');
fs.writeFileSync(BUILD_HTML, html);
fs.writeFileSync(BUILD_CSS, fs.readFileSync(path.join(DIR, 'guide.css'), 'utf8').replaceAll('%%VERSION%%', pkg.version));

/* ---------- print ---------- */
// The running header and footer come from CSS page-margin boxes (see guide.css). Unlike displayHeaderFooter
// templates, they can be switched off for the cover page, and they use the embedded Geist Mono font.
const pdfOpts = { format: 'A4', printBackground: true, preferCSSPageSize: true, outline: true, tagged: true, displayHeaderFooter: false, margin: { top: '17mm', bottom: '17mm', left: '15mm', right: '15mm' } };

const timer = setTimeout(() => { console.error('Timed out.'); process.exit(2); }, 420000);
const browser = await puppeteer.launch({
  executablePath: exe, headless: true, pipe: true, timeout: 40000,
  args: ['--no-sandbox', '--disable-gpu', '--disable-features=Translate,OptimizationHints', '--no-first-run', '--allow-file-access-from-files'],
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  await page.setViewport({ width: 794, height: 1123 });
  await page.goto(pathToFileURL(BUILD_HTML).href, { waitUntil: 'load', timeout: 120000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(i => (i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
  });
  const bad = await page.evaluate(() => [...document.images].filter(i => !i.naturalWidth).map(i => i.getAttribute('src')));
  if (bad.length) console.warn('Images that did not load:', bad.join(', '));
  const fontsOk = await page.evaluate(() => document.fonts.check('600 12px Geist') && document.fonts.check('12px "Geist Mono"'));
  if (!fontsOk) console.warn('Warning: Geist fonts did not load.');

  // number of pages: count the page objects, also inside compressed object streams
  const countPages = buf => {
    const re = /\/Type\s*\/Page(?![s\w])/g;
    buf = Buffer.from(buf);
    const bin = buf.toString('latin1');
    let n = (bin.match(re) || []).length;
    let at = 0;
    for (;;) {
      const a = bin.indexOf('stream', at);
      if (a < 0) break;
      const start = bin[a + 6] === '\r' ? a + 8 : a + 7;
      const end = bin.indexOf('endstream', start);
      if (end < 0) break;
      at = end + 9;
      if (end - start > 3_000_000 || buf[start] !== 0x78) continue;   // zlib streams begin with 0x78; skip big images
      try { n += (zlib.inflateSync(buf.subarray(start, end)).toString('latin1').match(re) || []).length; } catch { /* not a flate stream */ }
    }
    return n;
  };

  // pass 1: how many pages does each chapter take? (every chapter starts on a new page)
  const ids = await page.evaluate(() => [...document.querySelectorAll('section.chap')].map(s => s.id));
  const sizes = [];
  for (const id of ids) {
    await page.evaluate(want => document.querySelectorAll('section.chap, section.cover').forEach(s => { s.style.display = s.id === want ? '' : 'none'; }), id);
    sizes.push(countPages(await page.pdf({ ...pdfOpts, outline: false, tagged: false })));
  }
  await page.evaluate(() => document.querySelectorAll('section.chap, section.cover').forEach(s => { s.style.display = ''; }));
  console.log('chapter pages:', ids.map((id, i) => id + '=' + sizes[i]).join(' '));
  const start = {}; let at = 2;   // the cover is page 1
  ids.forEach((id, i) => { start[id] = at; at += sizes[i]; });
  await page.evaluate(map => document.querySelectorAll('[data-pg]').forEach(e => { e.textContent = String(map[e.getAttribute('data-pg')] ?? '?'); }), start);

  // pass 2: the real thing
  const buf = await page.pdf(pdfOpts);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);
  const n = countPages(buf);
  console.log(`Wrote ${path.relative(ROOT, OUT)}: ${n} pages (expected ${at - 1}), ${(buf.length / 1048576).toFixed(2)} MB, ${glossaryCount} glossary entries`);
  if (n !== at - 1) console.warn('Warning: page count differs from the sum of the chapters; contents page numbers may be off.');
} finally {
  clearTimeout(timer);
  await browser.close();
  for (const f of [BUILD_HTML, BUILD_CSS]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}
