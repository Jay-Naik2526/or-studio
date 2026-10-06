/**
 * Model persistence: localStorage (named models + autosave), JSON file download/upload and URL encoding.
 * A full localStorage falls back to a file download (spec §10.7).
 */
import LZ from 'lz-string';
import { SavedModel } from '../core/types/models';

const KEY = 'or_studio_models_v2';
const AUTO = 'or_studio_autosave_v2:';

export type SaveOutcome = { ok: true } | { ok: false; reason: 'quota' | 'unavailable'; message: string };

export const MODULE_IDS = ['lp', 'integer', 'nlp', 'transport', 'assign', 'network', 'project', 'queuing', 'inventory', 'games', 'markov', 'simulation'];

/** Saved models, newest first. Corrupt entries are skipped rather than breaking the list. */
export function listModels(moduleId?: string): SavedModel[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    const all = (Array.isArray(raw) ? raw : []).filter((m): m is SavedModel => !!m && typeof m === 'object' && typeof (m as SavedModel).moduleId === 'string' && !!(m as SavedModel).meta && (m as SavedModel).model !== undefined);
    all.sort((a, b) => (b.meta.createdAt || '').localeCompare(a.meta.createdAt || ''));
    return moduleId ? all.filter(m => m.moduleId === moduleId) : all;
  } catch { return []; }
}

export function renameModel(moduleId: string, oldTitle: string, newTitle: string): SaveOutcome {
  const title = newTitle.trim();
  if (!title) return { ok: false, reason: 'unavailable', message: 'The name cannot be empty.' };
  const all = listModels();
  if (all.some(x => x.moduleId === moduleId && x.meta.title === title && title !== oldTitle)) return { ok: false, reason: 'unavailable', message: `A model called “${title}” already exists.` };
  try {
    localStorage.setItem(KEY, JSON.stringify(all.map(x => (x.moduleId === moduleId && x.meta.title === oldTitle ? { ...x, meta: { ...x.meta, title } } : x))));
    return { ok: true };
  } catch { return { ok: false, reason: 'unavailable', message: 'Browser storage is unavailable.' }; }
}

export function clearAutosave(moduleId: string): void {
  try { localStorage.removeItem(AUTO + moduleId); } catch { /* ignore */ }
}

export function saveModel(m: SavedModel): SaveOutcome {
  try {
    const all = listModels().filter(x => !(x.moduleId === m.moduleId && x.meta.title === m.meta.title));
    all.push(m);
    localStorage.setItem(KEY, JSON.stringify(all));
    return { ok: true };
  } catch (e) {
    const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
    return { ok: false, reason: quota ? 'quota' : 'unavailable', message: quota ? 'Browser storage is full — the model was downloaded as a file instead.' : 'Browser storage is unavailable — the model was downloaded as a file instead.' };
  }
}

export function deleteModel(moduleId: string, title: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(listModels().filter(x => !(x.moduleId === moduleId && x.meta.title === title))));
  } catch { /* ignore */ }
}

export function autosave(moduleId: string, payload: unknown): void {
  try { localStorage.setItem(AUTO + moduleId, JSON.stringify({ at: Date.now(), payload })); } catch { /* quota: silently skip autosave */ }
}

export function loadAutosave<T>(moduleId: string): T | null {
  try {
    const raw = localStorage.getItem(AUTO + moduleId);
    return raw ? (JSON.parse(raw).payload as T) : null;
  } catch { return null; }
}

export function recentModules(): { moduleId: string; at: number }[] {
  const out: { moduleId: string; at: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(AUTO)) out.push({ moduleId: k.slice(AUTO.length), at: JSON.parse(localStorage.getItem(k)!).at });
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => b.at - a.at);
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'model';
}

export function downloadModel(m: SavedModel): void {
  downloadText(`${slug(m.meta.title)}.or-studio.json`, JSON.stringify(m, null, 2), 'application/json');
}

export async function readModelFile(file: File): Promise<SavedModel> {
  const text = await file.text();
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  const m = obj as SavedModel;
  if (!m || typeof m !== 'object' || !m.moduleId || m.model === undefined) throw new Error('This is not an OR-Studio model file (missing "moduleId" / "model").');
  if (!MODULE_IDS.includes(m.moduleId)) throw new Error(`This file is for an unknown module “${String(m.moduleId).slice(0, 30)}”.`);
  if (typeof m.model !== 'object' || m.model === null) throw new Error('The model inside this file is empty or damaged.');
  m.meta = { title: m.meta?.title || 'Imported model', createdAt: m.meta?.createdAt || '', notes: m.meta?.notes };
  return m;
}

/** Share link: the whole model, compressed into the URL fragment query. */
export function shareUrl(m: SavedModel, step?: number): string {
  const enc = LZ.compressToEncodedURIComponent(JSON.stringify(m));
  const base = window.location.href.split('#')[0];
  const q = new URLSearchParams({ model: enc });
  if (m.variant) q.set('variant', m.variant);
  if (step !== undefined) q.set('step', String(step));
  return `${base}#/m/${m.moduleId}?${q.toString()}`;
}

export function decodeShared(enc: string | null): SavedModel | null {
  if (!enc) return null;
  try {
    const json = LZ.decompressFromEncodedURIComponent(enc);
    if (!json) return null;
    const m = JSON.parse(json) as SavedModel;
    return m && MODULE_IDS.includes(m.moduleId) && typeof m.model === 'object' && m.model !== null ? { ...m, meta: m.meta ?? { title: 'Shared model', createdAt: '' } } : null;
  } catch { return null; }
}

/** Parse CSV / TSV / whitespace separated matrix text. */
export function parseMatrixText(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^\[|\]$/g, '').split(/[,\t;\s]+/).map(c => c.replace(/[[\]]/g, '').trim()).filter(c => c !== ''));
}
