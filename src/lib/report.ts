/**
 * Report model + exporters: LaTeX (amsmath + booktabs), printable HTML (→ PDF via the browser), CSV, JSON, PNG.
 * A complete submittable solution includes the problem, EVERY step with its explanation, the result and diagnostics (spec §11.9).
 */
import { toPng } from 'html-to-image';
import katex from 'katex';
import { downloadText, slug } from './persist';
import { unsubscript } from '../core/format';

export interface ReportTable { caption?: string; headers: string[]; rows: string[][]; highlightRows?: number[] }

export interface ReportStep {
  title: string;
  short: string;
  detailed?: string;
  rule?: string;
  formula?: string;
  note?: string;
  table?: ReportTable;
}

export interface Report {
  title: string;
  module: string;
  method?: string;
  problem: string;          // plain text statement of the model
  steps: ReportStep[];
  result: { heading: string; lines: string[]; tables?: ReportTable[] };
  diagnostics: string[];
  generatedAt?: string;
  /** inline SVG figures of the current view (colours already resolved for white paper) */
  figures?: { caption: string; svg: string }[];
}

/* ---------------------------- LaTeX ---------------------------- */

const SUBS: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
const SYM: Record<string, string> = {
  '≤': '\\le', '≥': '\\ge', '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '−': '-', '×': '\\times', '·': '\\cdot', '÷': '\\div', '∞': '\\infty',
  'ρ': '\\rho', 'λ': '\\lambda', 'μ': '\\mu', 'σ': '\\sigma', 'π': '\\pi', 'Σ': '\\Sigma', 'ε': '\\varepsilon', 'θ': '\\theta', 'Δ': '\\Delta', 'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'φ': '\\varphi', 'Φ': '\\Phi', 'ν': '\\nu',
  '⁺': '^{+}', '⁻': '^{-}', '′': "'", '≠': '\\neq', '≈': '\\approx', '√': '\\sqrt{}', '∑': '\\sum', '²': '^{2}', '³': '^{3}', '⁻¹': '^{-1}', '∈': '\\in', '⊕': '\\oplus', 'ᵢ': '_{i}', 'ⱼ': '_{j}',
};

export function texEscapePlain(s: string): string {
  return s.replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');
}

/** Convert free text (with unicode maths) to LaTeX text mode, wrapping symbols in $…$. */
export function tex(s: string): string {
  let out = '';
  let i = 0;
  const chars = [...s];
  while (i < chars.length) {
    const ch = chars[i]!;
    if (SUBS[ch]) {
      let d = '';
      while (i < chars.length && SUBS[chars[i]!]) { d += SUBS[chars[i]!]; i++; }
      out += `$_{${d}}$`;
      continue;
    }
    if (SYM[ch]) { out += `$${SYM[ch]}$`; i++; continue; }
    if (ch === '\n') { out += '\\\\ '; i++; continue; }
    out += texEscapePlain(ch);
    i++;
  }
  // merge adjacent math runs  $a$$b$ → $a b$
  return out.replace(/\$\$/g, ' ').replace(/(\d+)\/(\d+)/g, (_m, a, b) => `$\\frac{${a}}{${b}}$`).replace(/\$\s+\$/g, ' ');
}

export function texCell(s: string): string {
  const t = unsubscript(s);
  const frac = t.match(/^(-?)(\d+)\/(\d+)$/);
  if (frac) return `$${frac[1]}\\frac{${frac[2]}}{${frac[3]}}$`;
  if (/^-?\d+(\.\d+)?$/.test(t)) return `$${t}$`;
  return tex(s);
}

function texTable(t: ReportTable): string {
  const cols = 'l' + 'r'.repeat(Math.max(0, t.headers.length - 1));
  const wide = t.headers.length > 8;
  let out = '\\begin{center}\n';
  if (t.caption) out += `{\\small\\textit{${tex(t.caption)}}}\\\\[2pt]\n`;
  if (wide) out += '\\resizebox{\\linewidth}{!}{%\n';
  out += `\\begin{tabular}{${cols}}\n\\toprule\n${t.headers.map(h => `\\textbf{${tex(h)}}`).join(' & ')} \\\\\n\\midrule\n`;
  t.rows.forEach((r, i) => { out += `${t.highlightRows?.includes(i) ? '' : ''}${r.map(texCell).join(' & ')} \\\\\n`; });
  out += '\\bottomrule\n\\end{tabular}';
  if (wide) out += '}%';
  out += '\n\\end{center}\n';
  return out;
}

const TEX_MATH_OK = new Set(['frac', 'tfrac', 'dfrac', 'rho', 'lambda', 'mu', 'sigma', 'sqrt', 'sum', 'prod', 'ge', 'geq', 'le', 'leq', 'ne', 'neq', 'to', 'text', 'Big', 'big', 'Bigg', 'left', 'right', 'quad', 'qquad', 'alpha', 'beta', 'gamma', 'delta', 'Delta', 'theta', 'pi', 'Phi', 'varphi', 'epsilon', 'varepsilon', 'nu', 'cdot', 'times', 'div', 'infty', 'approx', 'pm', 'min', 'max', 'log', 'ln', 'exp', 'sin', 'cos', 'in', 'cdots', 'ldots', 'mid', 'binom', 'bar', 'hat', 'overline', 'partial', 'nabla', 'oplus', 'sup', 'inf', 'lim']);

/** A math fragment is passed through only when every control sequence is a harmless maths command; otherwise it is typeset as plain text. */
export function safeTexMath(f: string): string {
  const cmds = f.match(/\\[A-Za-z@]+/g) ?? [];
  if (cmds.some(c => !TEX_MATH_OK.has(c.slice(1)))) return `\\text{${texEscapePlain(f)}}`;
  return f.replace(/(^|[^\\])((?:\\\\)*)([%$#])/g, '$1$2\\$3').replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
}

/** Text placed inside a verbatim block must not be able to close it. */
export function verbatimSafe(s: string): string { return s.replace(/\\end\s*\{verbatim\}/gi, '\\end {verbatim}'); }

export function reportToLaTeX(r: Report): string {
  let o = `% Generated by OR-Studio\n\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{amsmath,amssymb,booktabs,geometry,graphicx}\n\\geometry{margin=2.2cm}\n\\setlength{\\parindent}{0pt}\\setlength{\\parskip}{6pt}\n\\begin{document}\n\n`;
  o += `\\begin{center}{\\Large\\bfseries ${tex(r.title)}}\\\\[2pt]{\\small ${tex(r.module)}${r.method ? ' --- ' + tex(r.method) : ''}}\\end{center}\n\n`;
  o += `\\section*{Problem}\n\\begin{verbatim}\n${verbatimSafe(unsubscriptSafe(r.problem))}\n\\end{verbatim}\n\n`;
  o += '\\section*{Solution steps}\n';
  r.steps.forEach((s, i) => {
    o += `\\subsection*{Step ${i + 1}: ${tex(s.title)}}\n${tex(s.short)}\n\n`;
    if (s.detailed) o += `${tex(s.detailed)}\n\n`;
    if (s.rule) o += `\\textit{Rule: ${tex(s.rule)}}\n\n`;
    if (s.formula) o += `\\[ ${safeTexMath(s.formula)} \\]\n`;
    if (s.note) o += `\\textbf{Note.} ${tex(s.note)}\n\n`;
    if (s.table) o += texTable(s.table);
  });
  o += `\\section*{${tex(r.result.heading)}}\n`;
  r.result.lines.forEach(l => (o += `${tex(l)}\n\n`));
  r.result.tables?.forEach(t => (o += texTable(t)));
  if (r.diagnostics.length) { o += '\\section*{Diagnostics}\n\\begin{itemize}\n'; r.diagnostics.forEach(d => (o += `\\item ${tex(d)}\n`)); o += '\\end{itemize}\n'; }
  o += '\n\\end{document}\n';
  return o;
}

function unsubscriptSafe(s: string): string { return s.replace(/[₀-₉]/g, c => `_${SUBS[c]}`).replace(/[≤]/g, '<=').replace(/[≥]/g, '>='); }

/* ---------------------------- HTML / PDF ---------------------------- */

export const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Last line of defence for figure markup: only a single <svg>…</svg> element, with scripts, foreign content, event handlers and script URLs removed. */
export function cleanSvg(svg: string): string {
  const t = String(svg).trim();
  if (!/^<svg[\s>]/i.test(t) || !/<\/svg>$/i.test(t)) return '';
  return t
    .replace(/<\s*(script|foreignObject|iframe|object|embed|link|meta|base|audio|video)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(xlink:)?href\s*=\s*("\s*(javascript|data):[^"]*"|'\s*(javascript|data):[^']*')/gi, '');
}

/** The report document runs no script at all; this also covers the same-origin frame used for printing. */
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
/** a/b → stacked fraction (also inside expressions such as 3/2 + 1/4M) */
const withFractions = (s: string) => esc(s).replace(/(−|-)?(\d+)\/(\d+)/g, (_m, sg, n, d) => `${sg ? '−' : ''}<span class="fr"><i>${n}</i><b>${d}</b></span>`);

function htmlTable(t: ReportTable): string {
  const dense = t.headers.length > 9 ? ' dense' : '';
  return `<div class="tw"><table class="t${dense}">${t.caption ? `<caption>${esc(t.caption)}</caption>` : ''}<thead><tr>${t.headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows
    .map((r, i) => `<tr${t.highlightRows?.includes(i) ? ' class="hl"' : ''}>${r.map((c, k) => (k === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${withFractions(c)}</td>`)).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function mathml(f: string): string {
  try { return katex.renderToString(f, { output: 'mathml', displayMode: true, throwOnError: false }); } catch { return `<code>${esc(f)}</code>`; }
}

const REPORT_CSS = `
@page{size:A4;margin:19mm 16mm 18mm;@top-left{content:"OR·Studio";font:600 8pt system-ui,sans-serif;color:#596884;letter-spacing:.08em}@top-right{content:var(--module);font:8pt system-ui,sans-serif;color:#596884}@bottom-left{content:var(--doc);font:8pt system-ui,sans-serif;color:#596884}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:8pt system-ui,sans-serif;color:#596884}}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
html{font:10.5pt/1.5 -apple-system,"Segoe UI",system-ui,Roboto,sans-serif;color:#0a1222}
body{margin:0 auto;max-width:182mm;padding:10mm 0}
.cover{border-top:5px solid #0a1222;padding-top:10px;margin-bottom:18px;position:relative}
.cover:before{content:"";position:absolute;left:0;top:-5px;width:84px;height:5px;background:#ccf53f}
.brand{font:600 8.5pt ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#596884}
h1{font-size:23pt;line-height:1.1;margin:6px 0 8px;letter-spacing:-.03em}
.meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:9pt;color:#596884}
.chip{font:600 8pt ui-monospace,Menlo,monospace;letter-spacing:.05em;text-transform:uppercase;border:1px solid #0a1222;color:#0a1222;padding:1px 7px}
.chip.lime{background:#ccf53f}
h2{font-size:12.5pt;margin:22px 0 8px;padding-bottom:4px;border-bottom:1px solid #b4c1d3;display:flex;align-items:baseline;gap:9px;break-after:avoid;letter-spacing:-.01em}
h2 .n{font:700 10pt ui-monospace,Menlo,monospace;background:#0a1222;color:#fff;padding:0 6px}
pre{background:#f2f5f9;border:1px solid #d3dce8;border-left:4px solid #0a1222;padding:8px 12px;white-space:pre-wrap;font:9.5pt/1.55 ui-monospace,Menlo,monospace;margin:0;break-inside:avoid}
.answer{border:1.5px solid #0a1222;background:#fbfdf0;padding:10px 14px;box-shadow:3px 3px 0 #ccf53f;break-inside:avoid}
.answer .hd{font:700 9pt ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#3b5a00;margin-bottom:3px}
.answer p{margin:3px 0;font-size:11.5pt;font-weight:600}
.tw{margin:8px 0;max-width:100%}
table.t{border-collapse:collapse;font:9.5pt ui-monospace,Menlo,monospace;border:1px solid #8fa0b8;break-inside:avoid}
table.t.dense{font-size:8pt}
.t th,.t td{border:1px solid #c5d0de;padding:2px 9px;text-align:center;white-space:nowrap}
.t.dense th,.t.dense td{padding:1px 5px}
.t thead th{background:#e4eaf2;font-weight:700}
.t tbody th{background:#f2f5f9;text-align:left;font-weight:700}
.t tr.hl td,.t tr.hl th{background:#eefbc2}
.t caption{caption-side:top;text-align:left;font:italic 9pt system-ui,sans-serif;color:#596884;padding-bottom:3px}
.fr{display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle;line-height:1;font-size:.82em;margin:0 1px}.fr i{font-style:normal;border-bottom:1px solid currentColor;padding:0 2px}.fr b{font-weight:inherit;padding:0 2px}
figure{margin:10px 0;break-inside:avoid;border:1px solid #d3dce8;padding:8px}figure svg{width:100%;height:auto;max-height:110mm;display:block}figcaption{font:italic 9pt system-ui,sans-serif;color:#596884;margin-top:4px}
.step{display:grid;grid-template-columns:32px 1fr;gap:0 10px;break-inside:avoid;padding:8px 0;border-bottom:1px dashed #c5d0de}
.sn{font:700 10pt ui-monospace,Menlo,monospace;color:#596884;padding-top:1px}
.step h3{font-size:10.5pt;margin:0 0 1px}
.short{font-weight:600}
.det{color:#29364f}
.rule{font:italic 9pt system-ui,sans-serif;color:#596884}
.rule b{font:600 8pt ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;font-style:normal;margin-right:4px}
.note{background:#f8ecb9;border-left:4px solid #7f5900;padding:3px 9px;margin:4px 0;font-size:9.5pt}
math{font-size:1.1em}
.diag{margin:0;padding-left:18px}.diag li{margin:3px 0}
.foot{margin-top:26px;padding-top:6px;border-top:1px solid #b4c1d3;font-size:8pt;color:#596884}
@media screen{body{padding:24px 18px;background:#fff}}
@media print{body{padding:0}}
`;

export function reportToHTML(r: Report): string {
  const when = r.generatedAt ?? new Date().toLocaleString();
  const steps = r.steps.map((s, i) => `<article class="step"><div class="sn">${String(i + 1).padStart(2, '0')}</div><div><h3>${esc(s.title)}</h3><div class="short">${esc(s.short)}</div>${s.detailed ? `<div class="det">${esc(s.detailed)}</div>` : ''}${s.formula ? mathml(s.formula) : ''}${s.rule ? `<div class="rule"><b>Rule</b>${esc(s.rule)}</div>` : ''}${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}${s.table ? htmlTable(s.table) : ''}</div></article>`).join('');
  const figs = (r.figures ?? []).map(f => `<figure>${cleanSvg(f.svg)}<figcaption>${esc(f.caption)}</figcaption></figure>`).join('');
  const cssStr = (x: string) => JSON.stringify(x).replace(/</g, '\\3c ').replace(/[\r\n]+/g, ' ');
  const cssVars = `:root{--module:${cssStr(r.module + (r.method ? ' · ' + r.method : ''))};--doc:${cssStr(r.title)}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><title>${esc(r.title)}</title><style>${cssVars}${REPORT_CSS}</style></head><body>
<header class="cover"><div class="brand">OR/Studio · solution report</div><h1>${esc(r.title)}</h1><div class="meta"><span class="chip lime">${esc(r.module)}</span>${r.method ? `<span class="chip">${esc(r.method)}</span>` : ''}<span>${esc(when)}</span></div></header>
<h2><span class="n">1</span>Problem</h2><pre>${esc(r.problem)}</pre>
<h2><span class="n">2</span>Answer</h2><div class="answer"><div class="hd">${esc(r.result.heading)}</div>${r.result.lines.map(l => `<p>${esc(l)}</p>`).join('')}</div>${(r.result.tables ?? []).map(htmlTable).join('')}${figs}
<h2><span class="n">3</span>Working</h2>${steps || '<p>No intermediate steps for this method.</p>'}
${r.diagnostics.length ? `<h2><span class="n">4</span>Notes and warnings</h2><ul class="diag">${r.diagnostics.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
<div class="foot">Generated by OR-Studio. All arithmetic is exact (rational numbers) unless a method states otherwise.</div>
</body></html>`;
}

/**
 * Prints the report through a hidden frame (no pop-up window, so pop-up blockers cannot interfere);
 * the user picks “Save as PDF” as the destination in the browser's print dialog.
 */
export function printReport(r: Report): boolean {
  try {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(reportToHTML(r));
    doc.close();
    const prevTitle = document.title;
    const cleanup = () => { document.title = prevTitle; window.setTimeout(() => frame.remove(), 400); };
    window.setTimeout(() => {
      try {
        document.title = r.title; // browsers propose the page title as the PDF file name
        frame.contentWindow!.addEventListener('afterprint', cleanup);
        frame.contentWindow!.focus();
        frame.contentWindow!.print();
      } catch { cleanup(); }
    }, 350);
    window.setTimeout(() => { if (frame.isConnected) cleanup(); }, 180000);
    return true;
  } catch { return false; }
}

/**
 * Snapshot the SVG figures under `root` as self-contained markup on a white page: CSS variables and the
 * dark theme are resolved (the dark class is lifted for the duration of the synchronous copy).
 */
export function snapshotFigures(root: HTMLElement | null, caption: string): { caption: string; svg: string }[] {
  if (!root) return [];
  const html = document.documentElement;
  const wasDark = html.classList.contains('dark');
  const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor'];
  const out: { caption: string; svg: string }[] = [];
  if (wasDark) html.classList.remove('dark');
  try {
    const svgs = [...root.querySelectorAll('svg')].filter(s => {
      const b = s.getBoundingClientRect();
      return b.width >= 260 && b.height >= 120 && !s.closest('button') && !s.classList.contains('lucide');
    }).slice(0, 3);
    svgs.forEach((src, k) => {
      const clone = src.cloneNode(true) as SVGSVGElement;
      const a = [src, ...src.querySelectorAll('*')];
      const b = [clone, ...clone.querySelectorAll('*')];
      a.forEach((el, i) => {
        const tgt = b[i] as SVGElement | undefined;
        if (!tgt) return;
        const cs = getComputedStyle(el);
        const css = props.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';');
        tgt.setAttribute('style', css);
        for (const at of ['fill', 'stroke', 'stroke-width', 'opacity', 'font-size', 'font-family', 'font-weight']) { if (tgt.getAttribute(at)?.includes('var(')) tgt.removeAttribute(at); }
        if (tgt.getAttribute('style')?.includes('var(')) tgt.setAttribute('style', css);
        if (tgt.tagName.toLowerCase() === 'text') { tgt.removeAttribute('class'); }
      });
      const bb = src.getBoundingClientRect();
      if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${Math.round(bb.width)} ${Math.round(bb.height)}`);
      clone.removeAttribute('width'); clone.removeAttribute('height'); clone.removeAttribute('class');
      clone.setAttribute('style', 'background:#fff');
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      out.push({ caption: svgs.length > 1 ? `${caption} (${k + 1}/${svgs.length})` : caption, svg: clone.outerHTML });
    });
  } finally { if (wasDark) html.classList.add('dark'); }
  return out;
}

/* ---------------------------- CSV / JSON / PNG ---------------------------- */

/** Quote a CSV field; a leading = + - @ (that is not a plain number) is neutralised so spreadsheets do not run it as a formula. */
export function csvCell(c: string): string {
  let v = String(c);
  if (/^[=@\t\r]/.test(v) || (/^[+-]/.test(v) && !/^[+-]?(\d|\.\d)/.test(v))) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

export function tableToCSV(t: ReportTable): string {
  const q = csvCell;
  return [t.headers, ...t.rows].map(r => r.map(q).join(',')).join('\n');
}

export function reportToCSV(r: Report): string {
  const tabs = r.result.tables ?? [];
  if (!tabs.length) return `${csvCell(r.result.heading)}\n${r.result.lines.map(csvCell).join('\n')}`;
  return tabs.map(t => `${t.caption ? `${csvCell('# ' + t.caption)}\n` : ''}${tableToCSV(t)}`).join('\n\n');
}

export function exportFiles(r: Report) {
  const base = slug(r.title);
  return {
    csv: () => downloadText(`${base}.csv`, reportToCSV(r), 'text/csv'),
    tex: () => downloadText(`${base}.tex`, reportToLaTeX(r), 'application/x-tex'),
    html: () => downloadText(`${base}.html`, reportToHTML(r), 'text/html'),
  };
}

export async function exportPNG(el: HTMLElement, filename: string): Promise<void> {
  const bg = getComputedStyle(document.body).backgroundColor;
  const url = await toPng(el, { pixelRatio: 2, backgroundColor: bg, cacheBust: true });
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(filename)}.png`;
  a.click();
}
