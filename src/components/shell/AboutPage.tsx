import { Check } from 'lucide-react';

const ROWS: [string, string, string][] = [
  ['D1/D2', 'Windows-only binary that no longer installs', 'Runs in any modern browser, installable as an offline app (PWA)'],
  ['D3', 'Fixed small window', 'Responsive from phone to 4K; Presentation mode (P) enlarges type for lectures'],
  ['D4', 'Shows tableaux but never says why', 'Every step has a written justification: reduced costs, all ratios, the pivot, the change in z'],
  ['D5', 'No export', 'PDF (print), LaTeX, PNG, CSV and JSON'],
  ['D6', 'No save / load', 'Autosave, named models, file download, shareable URL'],
  ['D7', 'Tutorial = right / wrong', 'Tutor mode diagnoses the misconception behind a wrong answer'],
  ['D8', 'Sensitivity = bare numbers', 'Range bars, what-if sliders and prose interpretation'],
  ['D9', 'Branch & bound as a flat list', 'Zoomable tree with bounds, branching variables and prune reasons'],
  ['D10', 'Adjacency-table input', 'Click-to-draw graph editor'],
  ['D11', 'Cryptic failure on degenerate / unbounded / infeasible', 'Each case detected, named and explained (unbounded ray, Farkas certificate, cycling guard…)'],
  ['D12', 'No keyboard / dark mode / accessibility', 'Keyboard-driven step player, dark mode, ARIA live regions, reduced-motion support'],
  ['D13', 'Closed source', 'MIT-licensed, solvers are plain TypeScript with no dependencies'],
];

export function AboutPage() {
  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div>
        <h1 className="display text-3xl font-semibold">About OR-Studio</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-2)' }}>OR-Studio is a browser-based replacement for TORA that solves the full Operations Research curriculum and shows every intermediate step with generated explanations. It has no server: everything runs on your device, so your models never leave it.</p>
      </div>
      <section className="card"><h2 className="card-h">Why it is different from TORA</h2>
        <div className="overflow-x-auto"><table className="tbl w-full"><thead><tr><th scope="col" className="rowhead">#</th><th scope="col" className="rowhead">TORA</th><th scope="col" className="rowhead">OR-Studio</th></tr></thead><tbody>{ROWS.map(r => <tr key={r[0]}><th scope="row">{r[0]}</th><td className="!text-left whitespace-normal">{r[1]}</td><td className="!text-left whitespace-normal"><Check size={13} className="inline mr-1" style={{ color: 'var(--ok)' }} aria-hidden="true" />{r[2]}</td></tr>)}</tbody></table></div>
      </section>
      <section className="card"><h2 className="card-h">Correctness claims</h2><div className="card-b text-sm flex flex-col gap-2">
        <p><b>Exact arithmetic.</b> Simplex pivots, MODI, Gomory cuts, branch &amp; bound, Markov steady states and game strategies use arbitrary-precision rational numbers: 1/3 is stored as 1/3 — never 0.333… — so degeneracy and cycling are detected reliably.</p>
        <p><b>Symbolic M.</b> Big-M and prohibited routes carry M as a separate coefficient; no numeric “big number” is ever substituted.</p>
        <p><b>Cross-checked.</b> The test suite compares the solvers against independent brute-force oracles on thousands of random instances (vertex enumeration for LP, enumeration for integer programs and assignments, LP for transportation and max-flow, and strong-duality checks).</p>
        <p><b>Honest limits.</b> Textbook-scale problems (a few hundred variables) are fast; this is not a replacement for industrial solvers. Closed-form modules (queues, inventory, simulation) use ordinary floating point, as is standard.</p>
      </div></section>
      <section className="card"><h2 className="card-h">Keyboard shortcuts</h2><div className="card-b grid sm:grid-cols-2 gap-1 text-sm">
        {[['← →', 'previous / next step'], ['Space', 'play / pause'], ['Home / End', 'first / last step'], ['1 – 9', 'jump to step n'], ['P', 'presentation mode'], ['Esc', 'leave presentation / close menus']].map(([k, d]) => <div key={k} className="flex gap-3 items-center"><span className="kbd w-24 text-center">{k}</span><span>{d}</span></div>)}
      </div></section>
      <p className="text-[0.82rem] muted">Based on the curriculum of Hamdy A. Taha, <i>Operations Research: An Introduction</i>. Not affiliated with the TORA software or its publisher.</p>
    </div>
  );
}
