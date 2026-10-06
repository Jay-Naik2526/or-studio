/**
 * Model persistence: localStorage (named models + autosave), JSON file download/upload and URL encoding.
 * A full localStorage falls back to a file download (spec §10.7).
 */
import LZ from 'lz-string';
import { SavedModel } from '../core/types/models';

const KEY = 'or_studio_models_v2';
const AUTO = 'or_studio_autosave_v2:';

export type SaveOutcome = { ok: true } | { ok: false; reason: 'quota' | 'unavailable'; message: string };

/** Limits for untrusted input (share links, files, stored data). */
export const MAX_SHARE_CHARS = 20_000;      // compressed share payload (LZ expands up to ~1000x, quadratic in the worst case)
export const MAX_MODEL_JSON = 4_000_000;    // decompressed / file size in characters
export const MAX_MODEL_DEPTH = 64;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON.parse that silently drops prototype-polluting keys at every level. */
export function safeParseJSON(text: string): unknown {
  return JSON.parse(text, (k, v) => (UNSAFE_KEYS.has(k) ? undefined : v));
}

/** True when `v` nests deeper than `max` levels (iterative, so hostile input cannot overflow the stack). */
export function exceedsDepth(v: unknown, max = MAX_MODEL_DEPTH): boolean {
  const stack: [unknown, number][] = [[v, 0]];
  let visited = 0;
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (d > max || ++visited > 2_000_000) return true;
    for (const c of Object.values(x as object)) stack.push([c, d + 1]);
  }
  return false;
}

const str = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' ? v.slice(0, max) : fallback);

/** Validate an untrusted value as a saved model. Returns null when it is not one; never throws. */
export function normalizeSaved(obj: unknown, fallbackTitle = 'Imported model'): SavedModel | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.moduleId !== 'string' || !MODULE_IDS.includes(o.moduleId)) return null;
  if (!o.model || typeof o.model !== 'object') return null;
  if (exceedsDepth(o.model)) return null;
  const meta = o.meta && typeof o.meta === 'object' ? (o.meta as Record<string, unknown>) : {};
  const out: SavedModel = {
    version: '1.0',
    moduleId: o.moduleId,
    model: o.model,
    meta: { title: str(meta.title, 200) || fallbackTitle, createdAt: str(meta.createdAt, 64) },
  };
  if (typeof o.variant === 'string') out.variant = o.variant.slice(0, 64);
  if (typeof meta.notes === 'string') out.meta.notes = meta.notes.slice(0, 5000);
  return out;
}

export const MODULE_IDS = ['lp', 'integer', 'nlp', 'transport', 'assign', 'network', 'project', 'queuing', 'inventory', 'games', 'markov', 'simulation'];

/** Saved models, newest first. Corrupt entries are skipped rather than breaking the list. */
export function listModels(moduleId?: string): SavedModel[] {
  try {
    const raw = safeParseJSON(localStorage.getItem(KEY) ?? '[]');
    const all = (Array.isArray(raw) ? raw : []).map(x => normalizeSaved(x, 'Untitled model')).filter((m): m is SavedModel => m !== null);
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

/** Returns false when the browser refused the write (storage full or blocked), so the caller can tell the user. */
export function autosave(moduleId: string, payload: unknown): boolean {
  try { localStorage.setItem(AUTO + moduleId, JSON.stringify({ at: Date.now(), payload })); return true; } catch { return false; }
}

export function loadAutosave<T>(moduleId: string): T | null {
  try {
    const raw = localStorage.getItem(AUTO + moduleId);
    if (!raw) return null;
    const payload = (safeParseJSON(raw) as { payload?: unknown } | null)?.payload;
    return payload !== undefined && !exceedsDepth(payload) ? (payload as T) : null;
  } catch { return null; }
}

export function recentModules(): { moduleId: string; at: number }[] {
  const out: { moduleId: string; at: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k !== null && k.startsWith(AUTO)) {
        const at = (safeParseJSON(localStorage.getItem(k) ?? 'null') as { at?: unknown } | null)?.at;
        if (typeof at === 'number' && Number.isFinite(at)) out.push({ moduleId: k.slice(AUTO.length), at });
      }
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
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60).replace(/_$/, '') || 'model';
}

export function downloadModel(m: SavedModel): void {
  downloadText(`${slug(m.meta.title)}.or-studio.json`, JSON.stringify(m, null, 2), 'application/json');
}

export async function readModelFile(file: File): Promise<SavedModel> {
  if (file.size > MAX_MODEL_JSON) throw new Error('This file is too large to be an OR-Studio model.');
  const text = await file.text();
  let obj: unknown;
  try { obj = safeParseJSON(text); } catch { throw new Error('This file is not valid JSON.'); }
  const o = obj as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o) || !o.moduleId || o.model === undefined) throw new Error('This is not an OR-Studio model file (missing "moduleId" / "model").');
  if (typeof o.moduleId !== 'string' || !MODULE_IDS.includes(o.moduleId)) throw new Error(`This file is for an unknown module “${String(o.moduleId).slice(0, 30)}”.`);
  const m = normalizeSaved(o);
  if (!m) throw new Error('The model inside this file is empty, damaged or nested too deeply.');
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
  if (!enc || enc.length > MAX_SHARE_CHARS) return null;
  try {
    const json = LZ.decompressFromEncodedURIComponent(enc);
    if (!json || json.length > MAX_MODEL_JSON) return null;
    return normalizeSaved(safeParseJSON(json), 'Shared model');
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
