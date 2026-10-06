import { useMemo, useState } from 'react';
import { GitCompare, CheckCircle2, AlertTriangle, Lightbulb } from 'lucide-react';
import { Step } from '../../core/types/step';
import { Btn, Card, Callout, Field } from '../ui/ui';
import { DiffComparator } from '../../core/diff/comparator';

export interface GridView { rowLabels: string[]; colLabels: string[]; cells: (string | null)[][] }

interface Props<S> {
  title: string;
  steps: Step<S>[];
  extract: (state: S) => GridView | null;
  /** short explanation to help interpret an error pattern */
  infer?: (user: (string | null)[][], correct: (string | null)[][], stepIndex: number) => string | undefined;
  blankLabel?: string;
  cellWidth?: string;
}

/** Diff Mode for grid-shaped states (allocations, reduced matrices, label tables): find the first diverging step. */
export function GridDiff<S>({ title, steps, extract, infer, blankLabel = 'blank = not allocated', cellWidth = 'w-14' }: Props<S>) {
  const grids = useMemo(() => steps.map(s => extract(s.state)), [steps, extract]);
  const first = grids.find(Boolean) ?? null;
  const [stepIdx, setStepIdx] = useState(Math.max(0, steps.length - 1));
  const [user, setUser] = useState<string[][]>(() => (first ? first.cells.map(r => r.map(() => '')) : []));
  const [res, setRes] = useState<null | { matches: boolean; step: number; diffs: { target: string; expected: string; actual: string }[]; cause?: string; closest: boolean }>(null);
  if (!first) return <Card title={title}><p className="text-sm muted">This module has no grid state to compare.</p></Card>;

  const run = (auto: boolean) => {
    const norm = (c: string | null | undefined) => (c === null || c === undefined || c === '' ? '–' : String(c).trim());
    const cmp = (k: number) => {
      const g = grids[k];
      if (!g) return null;
      const diffs = DiffComparator.compareGrids(user.map(r => r.map(c => (c.trim() === '' ? null : c.trim()))), g.cells.map(r => r.map(c => (c === null ? null : norm(c)))), g.rowLabels, g.colLabels);
      return { diffs, g };
    };
    let best = stepIdx;
    if (auto) {
      let bn = Infinity;
      grids.forEach((_, k) => { const c = cmp(k); if (c && c.diffs.length < bn) { bn = c.diffs.length; best = k; } });
    }
    const c = cmp(best);
    if (!c) return;
    const cause = c.diffs.length && infer ? infer(user.map(r => r.map(x => (x.trim() === '' ? null : x.trim()))), c.g.cells, best) : undefined;
    setRes({ matches: c.diffs.length === 0, step: best, diffs: c.diffs, cause, closest: auto });
  };

  return (
    <Card title={title} icon={<GitCompare size={14} />} right={<span className="badge badge-accent">Diff Mode · F11</span>}>
      <div className="flex flex-col gap-3">
        <p className="text-[0.82rem] muted">Type your hand working ({blankLabel}). The solver checks it against its own trajectory, finds the first step where you diverged and suggests why.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Compare with step">{id => (
            <select id={id} className="select" value={stepIdx} onChange={e => setStepIdx(Number(e.target.value))}>
              {steps.map((s, k) => <option key={k} value={k}>{k + 1}. {s.phase ?? 'Step'}</option>)}
            </select>
          )}</Field>
          <Btn onClick={() => { const g = grids[stepIdx]; if (g) setUser(g.cells.map(r => r.map(c => (c === null ? '' : c)))); }} title="Fill the grid with the solver's state to edit it">Start from solver state</Btn>
          <Btn onClick={() => setUser(first.cells.map(r => r.map(() => '')))}>Clear</Btn>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th />{first.colLabels.map((c, j) => <th key={j} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {user.map((row, i) => (
                <tr key={i}>
                  <th scope="row">{first.rowLabels[i]}</th>
                  {row.map((v, j) => (
                    <td key={j}><input className={`input num ${cellWidth}`} value={v} aria-label={`${first.rowLabels[i]}, ${first.colLabels[j]}`} onChange={e => setUser(u => u.map((r, ii) => (ii === i ? r.map((x, jj) => (jj === j ? e.target.value : x)) : r)))} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Btn variant="primary" onClick={() => run(false)}>Compare with selected step</Btn>
          <Btn onClick={() => run(true)}>Find the closest step</Btn>
        </div>
        {res && (res.matches ? (
          <Callout kind="ok"><CheckCircle2 size={14} className="inline mr-1" /> Your grid matches the solver exactly at step {res.step + 1}.</Callout>
        ) : (
          <div className="flex flex-col gap-2">
            <Callout kind="warn"><AlertTriangle size={14} className="inline mr-1" /> {res.closest ? `Closest match is step ${res.step + 1}` : `Step ${res.step + 1}`}: {res.diffs.length} cell{res.diffs.length === 1 ? '' : 's'} differ.</Callout>
            {res.cause && <Callout kind="info"><Lightbulb size={14} className="inline mr-1" /> Likely cause — {res.cause}</Callout>}
            <ul className="text-[0.82rem] mono flex flex-col gap-1 max-h-48 overflow-auto">
              {res.diffs.map((d, i) => <li key={i}><b>{d.target}</b>: expected <span style={{ color: 'var(--ok)' }}>{d.expected}</span>, you wrote <span style={{ color: 'var(--bad)' }}>{d.actual}</span></li>)}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
