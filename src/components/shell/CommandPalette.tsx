import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft, Home, BookMarked, FileText, Info, SunMoon, FlaskConical } from 'lucide-react';
import { MODULES } from './registry';
import { LIBRARY, MODULE_TITLES } from '../../data/library';
import { navigate } from '../../lib/router';
import { useModal } from '../ui/useModal';

interface Item { id: string; group: string; label: string; hint?: string; code?: string; keywords: string; run: () => void }

/** Mounted only while open, so state, focus trap and focus return all follow the dialog's lifetime. */
export function CommandPalette({ open, onClose, onToggleTheme }: { open: boolean; onClose: () => void; onToggleTheme: () => void }) {
  return open ? <PaletteBody onClose={onClose} onToggleTheme={onToggleTheme} /> : null;
}

function PaletteBody({ onClose, onToggleTheme }: { onClose: () => void; onToggleTheme: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dlgRef = useRef<HTMLDivElement>(null);
  useModal(dlgRef, onClose, { initialFocus: () => inputRef.current });

  const items = useMemo<Item[]>(() => [
    { id: 'p-home', group: 'Go to', label: 'Overview', code: '⌂', keywords: 'home hub start', run: () => navigate('/') },
    { id: 'p-lib', group: 'Go to', label: 'Problem library', hint: `${LIBRARY.length} worked problems`, code: '▤', keywords: 'examples textbook problems', run: () => navigate('/library') },
    { id: 'p-docs', group: 'Go to', label: 'Manual', code: '?', keywords: 'docs help guide shortcuts', run: () => navigate('/docs') },
    { id: 'p-about', group: 'Go to', label: 'About', code: 'i', keywords: 'about info licence', run: () => navigate('/about') },
    { id: 'a-theme', group: 'Action', label: 'Switch light / dark theme', code: '◐', keywords: 'theme dark light mode appearance', run: onToggleTheme },
    ...MODULES.map(m => ({ id: `m-${m.id}`, group: 'Solvers', label: m.name, hint: m.methods.slice(0, 3).join(' · '), code: m.short, keywords: `${m.methods.join(' ')} ${m.description}`, run: () => navigate(`/m/${m.id}`) })),
    ...LIBRARY.map(e => ({ id: `l-${e.id}`, group: 'Library', label: e.title, hint: MODULE_TITLES[e.module], code: '▸', keywords: `${e.description} ${e.tags.join(' ')} ${e.source}`, run: () => navigate(`/m/${e.module}`, { lib: e.id, variant: e.variant }) })),
  ], [onToggleTheme]);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items.filter(i => i.group !== 'Library').slice(0, 24);
    const words = t.split(/\s+/);
    const scored = items.map(i => {
      const label = i.label.toLowerCase();
      const hay = `${label} ${i.hint ?? ''} ${i.keywords}`.toLowerCase();
      if (!words.every(w => hay.includes(w))) return null;
      const s = (label.startsWith(t) ? 0 : label.includes(t) ? 1 : 2) + (i.group === 'Library' ? 0.5 : 0);
      return { i, s };
    }).filter((x): x is { i: Item; s: number } => x !== null);
    scored.sort((a, b) => a.s - b.s);
    return scored.slice(0, 30).map(x => x.i);
  }, [q, items]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const run = (i: Item | undefined) => { if (!i) return; onClose(); i.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.max(0, Math.min(results.length - 1, s + 1))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); run(results[sel]); }
  };

  let lastGroup = '';
  return (
    <div className="palette-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} role="presentation">
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" data-palette="" ref={dlgRef} onKeyDown={onKey}>
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
          <Search size={18} aria-hidden="true" className="muted" />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search solvers, methods and worked problems…" className="flex-1 bg-transparent outline-none text-[1.05rem]" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" autoComplete="off" spellCheck={false} aria-activedescendant={results[sel] ? `pal-${results[sel]!.id}` : undefined} aria-label="Search" />
          <span className="kbd">esc</span>
        </div>
        <ul id="palette-list" ref={listRef} role="listbox" className="overflow-y-auto py-1" aria-label="Results">
          {results.length === 0 && <li className="px-4 py-6 text-center muted break-words" role="presentation" aria-live="polite"><FlaskConical size={18} className="inline mr-2" aria-hidden="true" />Nothing matches “{q}”.</li>}
          {results.map((r, idx) => {
            const head = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <li key={r.id} role="presentation">
                {head && <div className="eyebrow px-4 pt-3 pb-1">{head}</div>}
                <div id={`pal-${r.id}`} role="option" aria-selected={idx === sel} className="palette-item" onMouseMove={() => setSel(idx)} onClick={() => run(r)}>
                  <span className="mono text-[0.72rem] font-bold w-10 text-center shrink-0" style={{ border: '1px solid var(--border-strong)', padding: '.1rem 0' }} aria-hidden="true">{r.code}</span>
                  <span className="font-semibold">{r.label}</span>
                  {r.hint && <span className="muted text-[0.85rem] truncate">{r.hint}</span>}
                  {idx === sel && <CornerDownLeft size={14} className="ml-auto muted shrink-0" aria-hidden="true" />}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-4 px-4 py-2 text-[0.8rem] muted" style={{ borderTop: '1px solid var(--line)', background: 'var(--surface-2)' }}>
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> move</span>
          <span><span className="kbd">↵</span> open</span>
          <span className="ml-auto inline-flex items-center gap-1"><Home size={12} aria-hidden="true" /><BookMarked size={12} aria-hidden="true" /><FileText size={12} aria-hidden="true" /><Info size={12} aria-hidden="true" /><SunMoon size={12} aria-hidden="true" /></span>
        </div>
      </div>
    </div>
  );
}
