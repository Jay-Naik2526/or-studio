import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Pencil, Save, Trash2, X, Check } from 'lucide-react';
import { SavedModel } from '../../core/types/models';
import { deleteModel, downloadModel, listModels, renameModel, saveModel } from '../../lib/persist';
import { MODULE_TITLES } from '../../data/library';
import { ModuleId } from '../../data/specs';
import { Btn } from '../ui/ui';

type Say = (kind: 'ok' | 'warn' | 'bad', text: string) => void;

interface Props {
  mode: 'save' | 'open';
  moduleId: string;
  current: SavedModel;
  onClose: () => void;
  onLoad: (m: SavedModel) => void;
  onPickFile: () => void;
  say: Say;
}

const when = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export function ModelsDialog({ mode, moduleId, current, onClose, onLoad, onPickFile, say }: Props) {
  const [tick, setTick] = useState(0);
  const [name, setName] = useState(current.meta.title && !/model$/.test(current.meta.title) ? current.meta.title : '');
  const [all, setAll] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [rename, setRename] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const models = (void tick, listModels(all ? undefined : moduleId));
  const clash = models.some(m => m.moduleId === moduleId && m.meta.title === name.trim());

  useEffect(() => { window.setTimeout(() => inputRef.current?.focus(), 0); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);

  const doSave = () => {
    const title = name.trim();
    if (!title) { say('warn', 'Give the model a name first.'); inputRef.current?.focus(); return; }
    const m: SavedModel = { ...current, meta: { ...current.meta, title, createdAt: new Date().toISOString() } };
    const res = saveModel(m);
    if (res.ok) { say('ok', `Saved “${title}” in this browser.`); onClose(); }
    else { downloadModel(m); say('warn', res.message); onClose(); }
  };

  const open = (m: SavedModel) => {
    if (m.moduleId !== moduleId) { sessionStorage.setItem('or_pending_model', JSON.stringify(m)); onClose(); window.location.hash = `#/m/${m.moduleId}`; window.location.reload(); return; }
    onLoad(m); say('ok', `Opened “${m.meta.title}”.`); onClose();
  };

  return (
    <div className="palette-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} role="presentation">
      <div className="palette" role="dialog" aria-modal="true" aria-label={mode === 'save' ? 'Save model' : 'Open model'} style={{ width: 'min(40rem, 100%)' }}>
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
          {mode === 'save' ? <Save size={18} aria-hidden="true" /> : <FolderOpen size={18} aria-hidden="true" />}
          <h2 className="text-[1.1rem] font-bold">{mode === 'save' ? 'Save this model' : 'Open a saved model'}</h2>
          <button className="btn btn-icon btn-ghost ml-auto" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        {mode === 'save' && (
          <div className="px-4 pt-4 flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[0.9rem] font-semibold">Name
              <input ref={inputRef} className="input" value={name} maxLength={80} placeholder="e.g. Week 4 — product mix" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') doSave(); }} />
            </label>
            {clash && <p className="text-[0.85rem]" style={{ color: 'var(--warn)' }}>A model with this name already exists — saving will replace it.</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              <Btn variant="primary" onClick={doSave}><Save size={14} /> {clash ? 'Replace' : 'Save in this browser'}</Btn>
              <Btn onClick={() => { downloadModel({ ...current, meta: { ...current.meta, title: name.trim() || current.meta.title, createdAt: new Date().toISOString() } }); say('ok', 'Model file downloaded.'); }}><Download size={14} /> Download as file</Btn>
            </div>
            <p className="text-[0.82rem] muted">Browser saves live on this device only. A downloaded file can be opened on any device, and “Copy share link” (toolbar) needs no file at all.</p>
          </div>
        )}

        <div className="flex items-center gap-3 px-4 pt-4 pb-1">
          <span className="eyebrow">{mode === 'save' ? 'Already saved' : 'Saved in this browser'}</span>
          <label className="ml-auto flex items-center gap-1.5 text-[0.85rem] cursor-pointer"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> all modules</label>
        </div>
        <ul className="overflow-y-auto px-2 pb-2 min-h-[4rem]" aria-label="Saved models" style={{ maxHeight: '38vh' }}>
          {models.length === 0 && <li className="px-2 py-4 text-center muted text-[0.92rem]">Nothing saved yet{all ? '' : ' for this module'}.</li>}
          {models.map(m => {
            const key = `${m.moduleId}|${m.meta.title}`;
            return (
              <li key={key} className="flex items-center gap-2 px-2 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                {renaming === key ? (
                  <>
                    <input className="input flex-1" aria-label="New name" value={rename} autoFocus onChange={e => setRename(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { const r = renameModel(m.moduleId, m.meta.title, rename); if (r.ok) { setRenaming(null); setTick(t => t + 1); } else say('warn', r.message); } }} />
                    <Btn size="icon" aria-label="Confirm rename" onClick={() => { const r = renameModel(m.moduleId, m.meta.title, rename); if (r.ok) { setRenaming(null); setTick(t => t + 1); } else say('warn', r.message); }}><Check size={14} /></Btn>
                    <Btn size="icon" variant="ghost" aria-label="Cancel rename" onClick={() => setRenaming(null)}><X size={14} /></Btn>
                  </>
                ) : (
                  <>
                    <button className="flex-1 min-w-0 text-left cursor-pointer" onClick={() => open(m)} aria-label={`Open ${m.meta.title}`}>
                      <div className="font-semibold truncate">{m.meta.title}</div>
                      <div className="text-[0.8rem] muted truncate">{all && <span className="mono">{MODULE_TITLES[m.moduleId as ModuleId] ?? m.moduleId} · </span>}{when(m.meta.createdAt)}</div>
                    </button>
                    {confirmDel === key ? (
                      <>
                        <span className="text-[0.82rem]" style={{ color: 'var(--bad)' }}>Delete?</span>
                        <Btn size="sm" onClick={() => { deleteModel(m.moduleId, m.meta.title); setConfirmDel(null); setTick(t => t + 1); }}>Yes</Btn>
                        <Btn size="sm" variant="ghost" onClick={() => setConfirmDel(null)}>No</Btn>
                      </>
                    ) : (
                      <>
                        <Btn size="icon" variant="ghost" aria-label={`Rename ${m.meta.title}`} title="Rename" onClick={() => { setRenaming(key); setRename(m.meta.title); }}><Pencil size={14} /></Btn>
                        <Btn size="icon" variant="ghost" aria-label={`Download ${m.meta.title}`} title="Download file" onClick={() => downloadModel(m)}><Download size={14} /></Btn>
                        <Btn size="icon" variant="ghost" aria-label={`Delete ${m.meta.title}`} title="Delete" onClick={() => setConfirmDel(key)}><Trash2 size={14} /></Btn>
                      </>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--line)', background: 'var(--surface-2)' }}>
          <Btn onClick={onPickFile}><FolderOpen size={14} /> Open a model file…</Btn>
          <span className="text-[0.82rem] muted ml-auto hidden sm:inline">.json files made with “Download as file”</span>
        </div>
      </div>
    </div>
  );
}
