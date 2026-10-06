import { useMemo, useState } from 'react';
import { SavedModel, Tableau } from '../../core/types/models';
import { Step } from '../../core/types/step';
import { Diagnostic } from '../../core/types/solver';
import { Report, ReportStep, ReportTable } from '../../lib/report';
import { loadAutosave, decodeShared, normalizeSaved, safeParseJSON } from '../../lib/persist';
import { LIBRARY, MODULE_TITLES } from '../../data/library';
import { ModuleId } from '../../data/specs';
import { MNum } from '../../core/math/bigm';

export interface Initial<T> { spec: T; variant?: string; step: number; title?: string }

/**
 * Does `val` have the same shape as `def`? Every key of the default must be present with the same kind of value
 * (string / number / boolean / array / object) and text fields are length-capped. Saved, shared or imported state
 * that does not conform is ignored instead of crashing the module that reads it.
 */
export function conforms(def: unknown, val: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof def === 'string') return typeof val === 'string' && val.length <= 100_000;
  if (typeof def === 'number' || typeof def === 'boolean') return typeof val === typeof def;
  if (Array.isArray(def)) {
    if (!Array.isArray(val) || val.length > 5000) return false;
    return def.length === 0 || val.every(v => conforms(def[0], v, depth + 1));
  }
  if (def && typeof def === 'object') {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
    return Object.keys(def).every(k => conforms((def as Record<string, unknown>)[k], (val as Record<string, unknown>)[k], depth + 1));
  }
  return true;
}

/** Initial module state priority: shared link ▸ pending file ▸ library item ▸ autosave ▸ default. */
export function readInitial<T>(moduleId: ModuleId, def: T): Initial<T> {
  const hash = window.location.hash.replace(/^#/, '');
  const q = new URLSearchParams(hash.split('?')[1] ?? '');
  const step = Number(q.get('step') ?? 0) || 0;
  const shared = decodeShared(q.get('model'));
  if (shared && shared.moduleId === moduleId && conforms(def, shared.model)) return { spec: shared.model as T, variant: shared.variant ?? q.get('variant') ?? undefined, step, title: shared.meta.title };
  try {
    const pending = sessionStorage.getItem('or_pending_model');
    if (pending) {
      const m = normalizeSaved(safeParseJSON(pending));
      if (m && m.moduleId === moduleId && conforms(def, m.model)) { sessionStorage.removeItem('or_pending_model'); return { spec: m.model as T, variant: m.variant, step: 0, title: m.meta.title }; }
    }
  } catch { /* ignore */ }
  const lib = q.get('lib');
  if (lib) {
    const e = LIBRARY.find(x => x.id === lib && x.module === moduleId);
    if (e) return { spec: structuredClone(e.spec) as T, variant: q.get('variant') ?? e.variant, step, title: e.title };
  }
  const auto = loadAutosave<SavedModel>(moduleId);
  if (auto && auto.model !== undefined && conforms(def, auto.model)) return { spec: auto.model as T, variant: auto.variant ?? q.get('variant') ?? undefined, step, title: auto.meta?.title };
  return { spec: def, variant: q.get('variant') ?? undefined, step };
}

export function useInitial<T>(moduleId: ModuleId, def: T): Initial<T> {
  const [init] = useState(() => readInitial(moduleId, def));
  return init;
}

export function makeSaved(moduleId: ModuleId, model: unknown, variant?: string, title?: string): SavedModel {
  return { version: '1.0', moduleId, variant, model, meta: { title: title || `${MODULE_TITLES[moduleId]} model`, createdAt: '' } };
}

export function useSaved(moduleId: ModuleId, model: unknown, variant?: string, title?: string): SavedModel {
  const json = JSON.stringify(model);
  return useMemo(() => makeSaved(moduleId, model, variant, title), [moduleId, json, variant, title]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function tableauTable(t: Tableau, caption?: string): ReportTable {
  const z = (j: number) => (t.bigMRow ? new MNum(t.objectiveRow[j]!, t.bigMRow[j]!).toString() : t.objectiveRow[j]!.toString());
  const zv = t.bigMRow ? new MNum(t.objectiveValue, t.objectiveValueM!).toString() : t.objectiveValue.toString();
  return {
    caption,
    headers: ['Basis', ...t.columnNames, 'RHS'],
    rows: [[t.objectiveLabel ?? 'z', ...t.columnNames.map((_, j) => z(j)), zv], ...t.matrix.map((r, i) => [t.columnNames[t.basis[i]!]!, ...r.map(v => v.toString()), t.rhs[i]!.toString()])],
  };
}

export function stepsToReport<S>(steps: Step<S>[], tableOf?: (s: S) => ReportTable | undefined): ReportStep[] {
  return steps.map(s => ({
    title: s.phase ?? `Step ${s.index + 1}`,
    short: s.explanation.short,
    detailed: s.explanation.detailed,
    rule: s.explanation.rule,
    formula: s.explanation.formula,
    note: s.explanation.note,
    table: tableOf?.(s.state),
  }));
}

export const diagText = (d: Diagnostic[]): string[] => d.map(x => `[${x.code}] ${x.message}${x.detail ? ' — ' + x.detail : ''}`);

export type MakeReport = (extra: Omit<Report, 'generatedAt'>) => Report;

/** Clamp a step index received from the URL. */
export const clampStep = (i: number, n: number) => Math.max(0, Math.min(i, Math.max(0, n - 1)));
