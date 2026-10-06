import { ArrowUpRight, BookMarked, Search } from 'lucide-react';
import { MODULES } from './registry';
import { recentModules } from '../../lib/persist';
import { href } from '../../lib/router';
import { LIBRARY } from '../../data/library';

const SECTIONS: { title: string; note: string; ids: string[] }[] = [
  { title: 'Optimise', note: 'Linear, integer and nonlinear models', ids: ['lp', 'integer', 'nlp'] },
  { title: 'Flows & plans', note: 'Networks, allocation and scheduling', ids: ['transport', 'assign', 'network', 'project'] },
  { title: 'Uncertainty & decisions', note: 'Queues, stock, games, chains, simulation', ids: ['queuing', 'inventory', 'games', 'markov', 'simulation'] },
];

/** Fig. 1 — a feasible polygon with the simplex walking vertex to vertex. Pure SVG + CSS motion. */
function Figure() {
  const path = 'M70 290 L400 290 L400 170 L280 80';
  return (
    <figure className="card" aria-label="Illustration: the simplex method moving along the edges of a feasible region to the optimal vertex">
      <svg viewBox="0 0 480 340" className="w-full block" role="img" aria-hidden="true" style={{ background: 'var(--surface)' }}>
        <defs>
          <pattern id="g" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="var(--grid-minor)" strokeWidth="1" /></pattern>
          <pattern id="G" width="120" height="120" patternUnits="userSpaceOnUse"><path d="M120 0H0V120" fill="none" stroke="var(--grid-major)" strokeWidth="1" /></pattern>
        </defs>
        <rect width="480" height="340" fill="url(#g)" /><rect width="480" height="340" fill="url(#G)" />
        <path d="M70 20 V290 H460" fill="none" stroke="var(--text)" strokeWidth="1.5" />
        <path d="M70 14 l-4 8 h8z M466 290 l-8 -4 v8z" fill="var(--text)" />
        <text x="478" y="284" textAnchor="end" className="mono" fontSize="13" fill="var(--text-3)">x₁</text>
        <text x="78" y="28" className="mono" fontSize="13" fill="var(--text-3)">x₂</text>
        <polygon points="70,290 70,200 150,120 280,80 400,170 400,290" fill="var(--hl)" fillOpacity="0.38" stroke="var(--text)" strokeWidth="1.6" />
        {[[150, 120], [280, 80], [400, 170], [400, 290], [70, 200], [70, 290]].map(([x, y]) => <rect key={`${x}-${y}`} x={x! - 4} y={y! - 4} width="8" height="8" fill="var(--surface)" stroke="var(--text)" strokeWidth="1.5" />)}
        <g stroke="var(--text-3)" strokeWidth="1.2" strokeDasharray="5 5" opacity=".8">
          <path d="M70 250 L230 70" /><path d="M70 205 L190 70" opacity=".5" /><path d="M120 290 L330 50" opacity=".5" />
        </g>
        <path d="M232 98 l34 -38" stroke="var(--entering)" strokeWidth="2" fill="none" /><path d="M266 60 l-9 3 6 6z" fill="var(--entering)" />
        <text x="196" y="116" fontSize="12.5" className="mono" fill="var(--entering)">∇z</text>
        <path d={path} fill="none" stroke="var(--text)" strokeWidth="2.6" strokeDasharray="620" className="hero-trace" />
        <circle cx="280" cy="80" r="11" fill="none" stroke="var(--text)" strokeWidth="1.5" className="hero-ring" />
        <rect x="274" y="74" width="12" height="12" fill="var(--accent)" stroke="var(--accent-edge)" strokeWidth="2" />
        <g className="mono" fontSize="13" fill="var(--text)">
          <text x="292" y="70">optimal</text>
          <text x="407" y="232" fill="var(--text-3)">pivot 2</text>
          <text x="164" y="324" fill="var(--text-3)">pivot 1</text>
        </g>
        <circle r="6" fill="var(--text)" className="hero-dot" style={{ offsetPath: `path('${path}')` }} />
      </svg>
      <figcaption className="card-h"><span>Fig. 1 — the simplex walks the edges</span><span className="hidden sm:inline">z = 3x₁ + 5x₂</span></figcaption>
    </figure>
  );
}

export function Hub() {
  const recent = recentModules().slice(0, 3);
  return (
    <div className="max-w-[1320px] mx-auto flex flex-col gap-12">
      <section className="grid xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-x-12 gap-y-8 items-center pt-2">
        <div>
          <p className="eyebrow mb-4">Operations research workbench · sheet 00</p>
          <h1 className="display text-[2.7rem] sm:text-[3.9rem] leading-[0.98] font-bold">Every pivot,<br /><span className="hl">explained.</span></h1>
          <p className="mt-6 max-w-xl text-[1.08rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>
            Twelve solvers in exact fractions. Step through each tableau, practise the decisions in Tutor mode, compare your hand working in Diff mode, and export a complete solution. Runs offline — nothing leaves your browser.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <a className="btn btn-primary !px-5 !py-2.5 !text-[1rem]" href={href('/m/lp')}>Open the simplex solver <ArrowUpRight size={16} /></a>
            <a className="btn !px-4 !py-2.5" href={href('/library')}><BookMarked size={15} /> {LIBRARY.length} worked problems</a>
            <span className="muted text-[0.9rem] inline-flex items-center gap-2"><Search size={14} aria-hidden="true" /> or press <span className="kbd">/</span> to search anything</span>
          </div>
          <dl className="mt-9 grid grid-cols-3 max-w-xl" style={{ border: '1px solid var(--line)', background: 'var(--surface)' }}>
            {[['12', 'solver modules'], ['∞', 'exact rationals'], ['0', 'servers needed']].map(([a, b], i) => (
              <div key={b} className="px-4 py-3" style={{ borderLeft: i ? '1px solid var(--line)' : 'none' }}>
                <dt className="mono text-[1.9rem] font-bold leading-none">{a}</dt>
                <dd className="eyebrow mt-1.5">{b}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Figure />
      </section>

      {recent.length > 0 && (
        <section aria-label="Continue where you left off" className="flex flex-wrap items-center gap-2">
          <span className="eyebrow mr-2">Resume</span>
          {recent.map(r => { const m = MODULES.find(x => x.id === r.moduleId); return m ? <a key={r.moduleId} className="btn btn-sm" href={href(`/m/${m.id}`)}><span className="mono font-bold">{m.short}</span> {m.name}</a> : null; })}
        </section>
      )}

      <section aria-label="Solvers" className="flex flex-col gap-10">
        {SECTIONS.map(sec => (
          <div key={sec.title}>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pb-3 mb-4" style={{ borderBottom: '1px solid var(--line)' }}>
              <h2 className="text-[1.45rem] font-bold">{sec.title}</h2>
              <p className="muted text-[0.92rem]">{sec.note}</p>
            </div>
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {sec.ids.map(id => {
                const m = MODULES.find(x => x.id === id)!;
                return (
                  <li key={m.id} className="flex">
                    <a href={href(`/m/${m.id}`)} className="tile w-full">
                      <div className="flex items-center justify-between">
                        <span className="code">{m.short}</span>
                        <ArrowUpRight size={17} className="muted" aria-hidden="true" />
                      </div>
                      <h3 className="text-[1.2rem] font-bold leading-tight">{m.name}</h3>
                      <p className="text-[0.93rem] leading-relaxed flex-1" style={{ color: 'var(--text-2)' }}>{m.description}</p>
                      <div className="flex flex-wrap gap-1.5 pt-1">{m.methods.slice(0, 4).map(x => <span key={x} className="badge">{x}</span>)}</div>
                      <p className="text-[0.82rem] muted pt-2" style={{ borderTop: '1px dashed var(--border-strong)' }}><b className="mono text-[0.74rem] uppercase tracking-wider" style={{ color: 'var(--text-2)' }}>Beyond TORA</b> · {m.beyondTora}</p>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
