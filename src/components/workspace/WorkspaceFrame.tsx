import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, Download, FileCode2, FileText, FileJson, Image as ImageIcon, Link2, Maximize, Minimize, Save, Table2, FolderOpen, GraduationCap, Zap, Printer } from 'lucide-react';
import { SavedModel } from '../../core/types/models';
import { Report, exportFiles, exportPNG, printReport, snapshotFigures } from '../../lib/report';
import { autosave, downloadModel, readModelFile, shareUrl } from '../../lib/persist';
import { navigate } from '../../lib/router';
import { Btn, Segmented, Card, Callout } from '../ui/ui';
import { moduleById } from '../shell/registry';
import { ModelsDialog } from './ModelsDialog';

export interface Tab { id: string; label: ReactNode; node: ReactNode; hidden?: boolean }

interface Props<V extends string> {
  moduleId: string;
  title: string;
  subtitle?: string;
  accent?: string;
  variants?: { value: V; label: string; title?: string }[];
  variant?: V;
  onVariant?: (v: V) => void;
  /** tutor support: undefined = module has no tutor (closed-form) */
  mode?: 'auto' | 'tutor';
  onMode?: (m: 'auto' | 'tutor') => void;
  tutorNote?: string;
  input: ReactNode;
  tabs: Tab[];
  side?: ReactNode;
  player?: ReactNode;
  status?: ReactNode;
  /** the serialisable model — autosaved, saved, shared */
  saved: SavedModel;
  onLoad: (m: SavedModel) => void;
  buildReport: () => Report | null;
  /** element to snapshot for PNG export */
  pngRef?: React.RefObject<HTMLElement | null>;
  step?: number;
  /** wide input column for matrix editors */
  wide?: boolean;
}

export function WorkspaceFrame<V extends string>(p: Props<V>) {
  const [tab, setTab] = useState(p.tabs[0]?.id ?? 'solution');
  const [presentation, setPresentation] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn' | 'bad'; text: string } | null>(null);
  const [menu, setMenu] = useState<'export' | null>(null);
  const [dlg, setDlg] = useState<'save' | 'open' | null>(null);
  const flag = (k: string) => { try { const v = localStorage.getItem(k); return v === null ? window.innerWidth >= 768 : v !== '0'; } catch { return true; } };
  const [inOpen, setInOpen] = useState(() => flag('or_ws_in'));
  useEffect(() => { try { localStorage.setItem('or_ws_in', inOpen ? '1' : '0'); } catch { /* ignore */ } }, [inOpen]);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useRef<number | undefined>(undefined);
  const say = (kind: 'ok' | 'warn' | 'bad', text: string) => {
    setToast({ kind, text });
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => setToast(null), 4500);
  };

  // autosave (debounced)
  const savedJson = useMemo(() => JSON.stringify(p.saved), [p.saved]);
  useEffect(() => {
    const h = window.setTimeout(() => autosave(p.moduleId, p.saved), 400);
    return () => window.clearTimeout(h);
  }, [savedJson, p.moduleId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.classList.toggle('presentation', presentation);
    return () => document.documentElement.classList.remove('presentation');
  }, [presentation]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (e.key === 'p' && !e.ctrlKey && !e.metaKey) setPresentation(v => !v);
      if (e.key === 'Escape') { setPresentation(false); setMenu(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const currentViewName = () => (document.querySelector('[aria-label="Views"] [role=tab][aria-selected=true]')?.textContent ?? 'Current view').trim();
  const visibleTabs = p.tabs.filter(x => !x.hidden);
  const activeTab = visibleTabs.find(x => x.id === tab) ?? visibleTabs[0];

  const withReport = (fn: (r: Report) => void) => {
    const r = p.buildReport();
    if (!r) { say('warn', 'Nothing to export yet — solve a valid model first.'); return; }
    r.figures = snapshotFigures(p.pngRef?.current ?? null, `${currentViewName()}${p.step !== undefined ? ` — step ${p.step + 1}` : ''}`);
    fn(r);
    setMenu(null);
  };

  const doShare = async () => {
    const url = shareUrl(p.saved, p.step);
    try { await navigator.clipboard.writeText(url); say('ok', `Link copied (${url.length.toLocaleString()} characters) — anyone opening it sees this model.`); }
    catch { window.prompt('Copy this link', url); }
  };

  const doPng = async () => {
    const el = p.pngRef?.current;
    if (!el) { say('warn', 'This view cannot be exported as an image.'); return; }
    try { await exportPNG(el, p.saved.meta.title || p.title); say('ok', 'PNG downloaded.'); }
    catch { say('bad', 'Image export failed in this browser.'); }
    setMenu(null);
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const m = await readModelFile(f);
      if (m.moduleId !== p.moduleId) { navigate(`/m/${m.moduleId}`, undefined); say('warn', `That file belongs to module “${m.moduleId}”; opening it there.`); sessionStorage.setItem('or_pending_model', JSON.stringify(m)); return; }
      p.onLoad(m);
      say('ok', `Loaded “${m.meta.title}”.`);
      setDlg(null);
    } catch (e) { say('bad', e instanceof Error ? e.message : 'Could not read the file.'); }
    setMenu(null);
  };

  const icon = (label: string, el: ReactNode, onClick: () => void, extra?: Record<string, unknown>) => (
    <Btn variant="ghost" size="icon" onClick={onClick} aria-label={label} title={label} {...extra}>{el}</Btn>
  );

  return (
    <div className="flex flex-col gap-4 max-w-[1560px] mx-auto" data-module={p.moduleId}>
      <div className="titleblock no-print">
        <div className="tb-code" aria-hidden="true">{moduleById(p.moduleId)?.short ?? p.moduleId.slice(0, 3).toUpperCase()}</div>
        <div className="tb-cell min-w-0">
          <h1 className="text-[1.35rem] sm:text-[1.9rem] leading-tight sm:leading-none font-bold" style={{ letterSpacing: '-0.035em' }}>{p.title}</h1>
          {p.subtitle && <p className="text-[0.86rem] muted mt-1.5 max-w-2xl hidden sm:block">{p.subtitle}</p>}
        </div>
        <div className="tb-ctl">
          {p.variants && p.variant !== undefined && p.onVariant && <Segmented label="Method" value={p.variant} onChange={p.onVariant} options={p.variants} />}
          {p.mode && p.onMode && (
            <Segmented label="Mode" value={p.mode} onChange={p.onMode} options={[{ value: 'auto', label: <span className="inline-flex items-center gap-1"><Zap size={12} /> Auto</span>, title: 'Solve and show every step' }, { value: 'tutor', label: <span className="inline-flex items-center gap-1"><GraduationCap size={12} /> Tutor</span>, title: 'Practise the decisions yourself' }]} />
          )}
          <div className="flex items-center border-l pl-3 gap-0.5 relative" style={{ borderColor: 'var(--border-strong)' }} role="toolbar" aria-label="Actions">
            {icon('Export…', <Download size={15} />, () => setMenu(menu === 'export' ? null : 'export'), { 'aria-expanded': menu === 'export' })}
            {icon('Save model…', <Save size={15} />, () => { setMenu(null); setDlg('save'); })}
            {icon('Open saved model…', <FolderOpen size={15} />, () => { setMenu(null); setDlg('open'); })}
            {icon('Copy share link', <Link2 size={15} />, () => void doShare())}
            {icon(presentation ? 'Exit presentation (P)' : 'Presentation mode (P)', presentation ? <Minimize size={15} /> : <Maximize size={15} />, () => setPresentation(v => !v), { 'aria-pressed': presentation })}
            <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={e => { void onFile(e.target.files?.[0]); e.target.value = ''; }} aria-label="Open model file" />
            {menu === 'export' && (
              <div className="absolute right-0 top-full mt-1 card p-1 flex flex-col z-40 min-w-[250px]" role="menu" style={{ boxShadow: '0 12px 30px rgb(0 0 0 / 25%)' }}>
                <Btn variant="ghost" className="justify-start" role="menuitem" onClick={() => withReport(r => { if (!printReport(r)) say('warn', 'Pop-up blocked: allow pop-ups to print the report.'); })}><Printer size={14} /> PDF — full solution</Btn>
                <Btn variant="ghost" className="justify-start" role="menuitem" onClick={() => withReport(r => exportFiles(r).tex())}><FileCode2 size={14} /> LaTeX (.tex)</Btn>
                <Btn variant="ghost" className="justify-start" role="menuitem" onClick={() => void doPng()}><ImageIcon size={14} /> PNG — current view</Btn>
                <Btn variant="ghost" className="justify-start" role="menuitem" onClick={() => withReport(r => exportFiles(r).csv())}><Table2 size={14} /> CSV — result tables</Btn>
                <Btn variant="ghost" className="justify-start" role="menuitem" onClick={() => { downloadModel(p.saved); setMenu(null); }}><FileJson size={14} /> JSON — model</Btn>
                <Btn variant="ghost" className="justify-start" role="menuitem" onClick={() => withReport(r => exportFiles(r).html())}><FileText size={14} /> HTML report</Btn>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`nb ${presentation ? 'nb-pres' : ''}`}>
        {!presentation && (
          <section className="nb-sec no-print" aria-label="Model">
            <div className="nb-gut" aria-hidden="true">01</div>
            <div className="min-w-0">
              <div className="nb-h">
                <span className="mono muted lg:hidden">01</span>
                <h2>Model</h2>
                <span className="muted text-[0.88rem] hidden sm:inline">What you are solving — edit anything and the solution below updates.</span>
                {!inOpen && <span className="muted text-[0.88rem] sm:hidden">tap Show to edit</span>}
                <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={() => setInOpen(v => !v)} aria-expanded={inOpen}>{inOpen ? <><ChevronsDownUp size={14} /> Hide</> : <><ChevronsUpDown size={14} /> Show</>}</button>
              </div>
              {inOpen && <div className="nb-input">{p.input}</div>}
            </div>
          </section>
        )}

        <section className="nb-sec" aria-label="Solution">
          <div className="nb-gut no-print" aria-hidden="true">02</div>
          <div className="min-w-0 flex flex-col gap-4">
            <div className="nb-h no-print">
              <span className="mono muted lg:hidden">02</span>
              <h2>Solution</h2>
              <span className="muted text-[0.88rem] hidden sm:inline">Result, then the reasoning for the current step, then the working.</span>
            </div>
            {p.status}
            {visibleTabs.length > 1 && (
              <div role="tablist" aria-label="Views" className="tabs no-print">
                {visibleTabs.map(x => <button key={x.id} role="tab" aria-selected={activeTab?.id === x.id} onClick={() => setTab(x.id)} className="tab">{x.label}</button>)}
              </div>
            )}
            <div className="nb-reason">{p.side}</div>
            <div ref={p.pngRef as React.RefObject<HTMLDivElement>} className="flex flex-col gap-4 min-w-0">{activeTab?.node}</div>
          </div>
        </section>
        {p.player && <div className="dock px-4 py-2.5 no-print">{p.player}</div>}
      </div>

      <p className="text-[13px] muted no-print hide-in-presentation">Autosaved in this browser · <span className="kbd">←</span> <span className="kbd">→</span> step · <span className="kbd">Space</span> play · <span className="kbd">P</span> present</p>

      {dlg && <ModelsDialog mode={dlg} moduleId={p.moduleId} current={p.saved} onClose={() => setDlg(null)} onLoad={p.onLoad} onPickFile={() => fileRef.current?.click()} say={say} />}

      {toast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 max-w-[92vw]">
          <Callout kind={toast.kind}>{toast.text}</Callout>
        </div>
      )}
    </div>
  );
}

export function WorkspaceNote({ children }: { children: ReactNode }) {
  return <Card><div className="text-[0.82rem] muted leading-relaxed">{children}</div></Card>;
}
