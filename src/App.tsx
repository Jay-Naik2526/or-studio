import { Suspense, useCallback, useEffect, useState } from 'react';
import { Moon, Sun, Menu, X, Home, BookMarked, FileText, Info, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { useRoute, href } from './lib/router';
import { useTheme } from './components/shell/theme';
import { Hub } from './components/shell/Hub';
import { LibraryPage } from './components/shell/LibraryPage';
import { AboutPage } from './components/shell/AboutPage';
import { DocsPage } from './components/shell/DocsPage';
import { MODULES, moduleById } from './components/shell/registry';
import { ErrorBoundary } from './components/shell/ErrorBoundary';
import { CommandPalette } from './components/shell/CommandPalette';

const GROUPS: { title: string; ids: string[] }[] = [
  { title: 'Optimise', ids: ['lp', 'integer', 'nlp'] },
  { title: 'Flows & plans', ids: ['transport', 'assign', 'network', 'project'] },
  { title: 'Uncertainty & decisions', ids: ['queuing', 'inventory', 'games', 'markov', 'simulation'] },
];

function Logo({ compact }: { compact?: boolean }) {
  return (
    <a href={href('/')} className="flex items-center gap-2.5 px-3.5 h-[52px]" aria-label="OR·Studio home" style={{ textDecoration: 'none' }}>
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="1" y="1" width="30" height="30" fill="var(--accent)" stroke="var(--accent-edge)" strokeWidth="2" />
        <path d="M6 24 L13 11 L18 19 L26 7" fill="none" stroke="var(--on-accent)" strokeWidth="2.6" strokeLinecap="square" strokeLinejoin="miter" />
        <circle cx="26" cy="7" r="2.4" fill="var(--on-accent)" />
      </svg>
      {!compact && <span className="text-[1.15rem] font-bold tracking-tight leading-none" style={{ color: 'var(--text)', letterSpacing: '-0.03em' }}>OR<span className="mono font-medium" style={{ color: 'var(--text-3)' }}>/</span>Studio</span>}
    </a>
  );
}

export default function App() {
  const route = useRoute();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const [pal, setPal] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { const v = localStorage.getItem('or_rail'); return v === null ? window.innerWidth < 1560 : v === '1'; } catch { return false; } });
  const [first, second] = route.path;
  const mod = first === 'm' && second ? moduleById(second) : undefined;
  const Mod = mod?.component;
  useEffect(() => { setOpen(false); }, [route.raw]);
  useEffect(() => { try { localStorage.setItem('or_rail', collapsed ? '1' : '0'); } catch { /* ignore */ } }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPal(p => !p); return; }
      const el = e.target as HTMLElement | null;
      if (e.key === '/' && !(el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable))) { e.preventDefault(); setPal(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const closePal = useCallback(() => setPal(false), []);

  const links = [
    { to: '/', label: 'Overview', icon: Home, active: route.path.length === 0 },
    { to: '/library', label: 'Problem library', icon: BookMarked, active: first === 'library' },
    { to: '/docs', label: 'Manual', icon: FileText, active: first === 'docs' },
    { to: '/about', label: 'About', icon: Info, active: first === 'about' },
  ];
  const crumb = mod ? mod.name : first === 'library' ? 'Problem library' : first === 'docs' ? 'Manual' : first === 'about' ? 'About' : 'Overview';

  const rail = (compact: boolean) => (
    <nav aria-label="Main" className="flex flex-col h-full overflow-y-auto">
      <Logo compact={compact} />
      <div className="mt-1" style={{ borderTop: '1px solid var(--border)' }}>
        {links.map(l => (
          <a key={l.to} href={href(l.to)} className="rail-link" aria-current={l.active ? 'page' : undefined} title={l.label}>
            <span className="code"><l.icon size={14} aria-hidden="true" /></span>{!compact && l.label}
          </a>
        ))}
      </div>
      {GROUPS.map(g => (
        <div key={g.title}>
          {!compact ? <div className="rail-sec">{g.title}</div> : <div className="mt-3 mx-3" style={{ borderTop: '1px solid var(--border)' }} />}
          {g.ids.map(id => {
            const m = MODULES.find(x => x.id === id)!;
            return (
              <a key={id} href={href(`/m/${id}`)} className="rail-link" aria-current={mod?.id === id ? 'page' : undefined} title={m.name}>
                <span className="code" aria-hidden="true">{m.short}</span>
                {!compact && m.name}
              </a>
            );
          })}
        </div>
      ))}
      <div className="mt-auto p-2 flex gap-1 items-center" style={{ borderTop: '1px solid var(--border)' }}>
        <button className="btn btn-sm btn-ghost hidden lg:inline-flex" onClick={() => setCollapsed(c => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? <PanelLeftOpen size={15} /> : <><PanelLeftClose size={15} /> Collapse</>}</button>
      </div>
    </nav>
  );

  const themeBtn = (
    <button className="btn btn-icon btn-ghost" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme">{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
  );

  return (
    <div className="min-h-screen lg:flex">
      <a className="skip" href="#main">Skip to content</a>
      <aside className={`rail no-print hidden lg:block sticky top-0 h-screen shrink-0 ${collapsed ? 'w-[68px]' : 'w-[258px]'}`}>{rail(collapsed)}</aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div className="rail absolute left-0 top-0 bottom-0 w-[280px] max-w-[85vw]">
            <button className="btn btn-icon btn-ghost absolute right-1 top-2" onClick={() => setOpen(false)} aria-label="Close menu"><X size={17} /></button>
            {rail(false)}
          </div>
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="topbar no-print sticky top-0 z-40 flex items-center gap-3 h-[52px] pr-3 lg:px-6">
          <div className="lg:hidden shrink-0"><Logo compact /></div>
          <nav aria-label="Breadcrumb" className="hidden sm:flex items-center gap-2 mono text-[0.82rem] min-w-0">
            <a href={href('/')} className="muted hover:underline" style={{ textDecoration: 'none' }}>OR/STUDIO</a>
            <span className="muted" aria-hidden="true">/</span>
            <span className="font-semibold truncate uppercase tracking-wide">{crumb}</span>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <button className="searchbtn" onClick={() => setPal(true)} aria-label="Open command palette (Ctrl or Command K)">
              <Search size={15} aria-hidden="true" />
              <span className="flex-1 text-left hidden sm:inline">Search solvers &amp; problems</span>
              <span className="kbd hidden sm:inline">⌘K</span>
            </button>
            {themeBtn}
            <button className="btn btn-icon btn-ghost lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={19} /></button>
          </div>
        </header>
        <main id="main" className="flex-1 min-w-0 px-4 sm:px-6 py-6">
          <ErrorBoundary resetKey={route.raw.split('?')[0]}>
            <Suspense fallback={<div className="muted text-sm py-10 text-center mono" role="status">LOADING SHEET…</div>}>
              {route.path.length === 0 && <Hub />}
              {first === 'library' && <LibraryPage />}
              {first === 'about' && <AboutPage />}
              {first === 'docs' && <DocsPage />}
              {Mod && <Mod key={mod!.id + (route.query.get('lib') ?? '') + (route.query.get('model')?.slice(0, 12) ?? '')} />}
              {first === 'm' && !mod && <div className="callout callout-bad">Unknown module “{second}”. <a href={href('/')} className="underline">Back to the overview</a></div>}
              {first && !['m', 'library', 'about', 'docs'].includes(first) && <div className="callout callout-warn">Page not found. <a href={href('/')} className="underline">Back to the overview</a></div>}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <CommandPalette open={pal} onClose={closePal} onToggleTheme={toggle} />
    </div>
  );
}
