import { useMemo, useState } from 'react';
import { SavedModel, Tableau } from '../../core/types/models';
import { Step } from '../../core/types/step';
import { Diagnostic } from '../../core/types/solver';
import { Report, ReportStep, ReportTable } from '../../lib/report';
import { loadAutosave, decodeShared } from '../../lib/persist';
import { LIBRARY, MODULE_TITLES } from '../../data/library';
import { ModuleId } from '../../data/specs';
import { MNum } from '../../core/math/bigm';

export interface Initial<T> { spec: T; variant?: string; step: number; title?: string }

/** Initial module state priority: shared link ▸ pending file ▸ library item ▸ autosave ▸ default. */
export function readInitial<T>(moduleId: ModuleId, def: T): Initial<T> {
  const hash = window.location.hash.replace(/^#/, '');
  const q = new URLSearchParams(hash.split('?')[1] ?? '');
  const step = Number(q.get('step') ?? 0) || 0;
  const shared = decodeShared(q.get('model'));
  if (shared && shared.moduleId === moduleId) return { spec: shared.model as T, variant: shared.variant ?? q.get('variant') ?? undefined, step, title: shared.meta.title };
  try {
    const pending = sessionStorage.getItem('or_pending_model');
    if (pending) {
      const m = JSON.parse(pending) as SavedModel;
      if (m.moduleId === moduleId) { sessionStorage.removeItem('or_pending_model'); return { spec: m.model as T, variant: m.variant, step: 0, title: m.meta.title }; }
    }
  } catch { /* ignore */ }
  const lib = q.get('lib');
  if (lib) {
    const e = LIBRARY.find(x => x.id === lib && x.module === moduleId);
    if (e) return { spec: structuredClone(e.spec) as T, variant: q.get('variant') ?? e.variant, step, title: e.title };
  }
  const auto = loadAutosave<SavedModel>(moduleId);
  if (auto && auto.model !== undefined) return { spec: auto.model as T, variant: auto.variant ?? q.get('variant') ?? undefined, step, title: auto.meta?.title };
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
