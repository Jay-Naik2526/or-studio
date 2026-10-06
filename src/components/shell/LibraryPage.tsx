import { useMemo, useState } from 'react';
import { Search, Play } from 'lucide-react';
import { LIBRARY, MODULE_TITLES } from '../../data/library';
import { ModuleId } from '../../data/specs';
import { href } from '../../lib/router';
import { Badge } from '../ui/ui';

export function LibraryPage() {
  const [q, setQ] = useState('');
  const [mod, setMod] = useState<'all' | ModuleId>('all');
  const rows = useMemo(() => LIBRARY.filter(e => (mod === 'all' || e.module === mod) && (q === '' || `${e.title} ${e.description} ${e.tags.join(' ')} ${e.source}`.toLowerCase().includes(q.toLowerCase()))), [q, mod]);
  const mods = Object.keys(MODULE_TITLES) as ModuleId[];
  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-4">
      <div>
        <h1 className="display text-3xl font-semibold">Problem library</h1>
        <p className="text-sm muted">Worked textbook problems and edge cases. Each opens in its module with the right method preselected; the answers are re-derived by the automated tests.</p>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <label className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 muted" aria-hidden="true" />
          <input className="input !pl-7 !w-64" placeholder="Search problems…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search problems" />
        </label>
        <div role="group" aria-label="Filter by module" className="flex flex-wrap gap-1">
          <button className="btn btn-sm" aria-pressed={mod === 'all'} onClick={() => setMod('all')}>All</button>
          {mods.map(m => <button key={m} className="btn btn-sm" aria-pressed={mod === m} onClick={() => setMod(m)}>{MODULE_TITLES[m]}</button>)}
        </div>
      </div>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map(e => (
          <li key={e.id} className="card p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2"><Badge kind="accent">{MODULE_TITLES[e.module]}</Badge>{e.variant && <span className="badge">{e.variant}</span>}</div>
            <h2 className="font-bold text-sm">{e.title}</h2>
            <p className="text-[0.82rem] flex-1" style={{ color: 'var(--text-2)' }}>{e.description}</p>
            <p className="text-[13px] muted">{e.source}</p>
            <div className="flex items-center justify-between gap-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
              <span className="text-[13px] mono" style={{ color: 'var(--ok)' }}>{e.expected}</span>
              <a className="btn btn-primary btn-sm" href={href(`/m/${e.module}`, { lib: e.id, variant: e.variant })}><Play size={12} /> Open</a>
            </div>
          </li>
        ))}
      </ul>
      {rows.length === 0 && <p className="muted text-sm">No problems match.</p>}
    </div>
  );
}
