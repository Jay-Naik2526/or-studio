import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { LPModel } from '../../core/types/models';
import { enumerateBasicSolutions, definitionsFor, BasicSolutionsOk, BasicSolutionsFail } from '../../core/solvers/lp/basicSolutions';
import { Card, Callout, Badge, Btn } from '../ui/ui';
import { Q } from '../ui/Q';

const SHOW = 300;

export function useBasicSolutions(model: LPModel | null): BasicSolutionsOk | BasicSolutionsFail | null {
  return useMemo(() => {
    if (!model) return null;
    try { return enumerateBasicSolutions(model); } catch (e) { return { ok: false as const, reason: e instanceof Error ? e.message : 'Basic solutions could not be enumerated.' }; }
  }, [model]);
}

export function BasicSolutionsBody({ model, status }: { model: LPModel; status?: string }) {
  const res = useBasicSolutions(model);
  const [onlyFeasible, setOnlyFeasible] = useState(false);
  const [all, setAll] = useState(false);
  const defs = useMemo(() => definitionsFor(model, res), [model, res]);

  const defCard = (
    <Card title="Definitions, with your model's numbers">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-[0.9rem] [&>*]:min-w-0">
        {defs.map(d => (
          <div key={d.term}>
            <dt className="font-semibold">{d.term}</dt>
            <dd className="muted leading-snug">{d.meaning}</dd>
            <dd className="leading-snug mt-0.5">{d.example}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );

  if (!res) return <Card title="Basic solutions" icon={<Layers size={14} />}><p className="text-sm muted">Fix the model to list its basic solutions.</p></Card>;
  if (!res.ok) {
    return (
      <div className="flex flex-col gap-3">
        <Card title="Basic solutions" icon={<Layers size={14} />}><Callout kind="warn" title={res.tooMany ? `${res.count} candidate bases` : undefined}>{res.reason}</Callout></Card>
        {defCard}
      </div>
    );
  }

  const rows = onlyFeasible ? res.bases.filter(b => b.status === 'feasible') : res.bases;
  const shown = all ? rows : rows.slice(0, SHOW);
  const names = res.varNames;
  const unbounded = status === 'unbounded' || status === 'unbounded-objective';
  return (
    <div className="flex flex-col gap-3">
      <Card title="All basic solutions" icon={<Layers size={14} />} right={<Badge kind="accent">C({res.n}, {res.m}) = {res.total}</Badge>}>
        <div className="flex flex-col gap-3">
          <p className="text-[0.9rem]">
            The standard form has <b>{res.m}</b> independent equation{res.m === 1 ? '' : 's'} in <b>{res.n}</b> variables, so a basis picks {res.m} columns and sets the other {res.n - res.m} variables to 0.
            Of the {res.total} candidates, <b>{res.counts.feasible}</b> are basic feasible (extreme points), <b>{res.counts.infeasible}</b> are basic but infeasible, and <b>{res.counts.singular}</b> {res.counts.singular === 1 ? "is not a basis" : "are not bases"} at all (dependent columns).
            {res.counts.degenerate > 0 && <> <b>{res.counts.degenerate}</b> feasible one{res.counts.degenerate === 1 ? ' is' : 's are'} degenerate (a basic variable equals 0).</>}
          </p>
          {res.notes.filter(n => n.includes('redundant')).map((n, i) => <Callout key={i} kind="info">{n}</Callout>)}
          {res.best === null && <Callout kind="warn">No basic feasible solution exists: {res.counts.feasible === 0 ? 'the feasible region is empty.' : ''}</Callout>}
          {res.best !== null && unbounded && <Callout kind="warn">The objective is unbounded, so there is no optimal solution; the best vertex below is only the best corner, not an optimum.</Callout>}
          {res.best !== null && !unbounded && <Callout kind="ok" title="Best basic feasible solution">{res.sense === 'max' ? 'max' : 'min'} z = <b className="mono"><Q v={res.best} /></b> — the optimal solution is always found among the extreme points (fundamental theorem of LP).</Callout>}
          <label className="inline-flex items-center gap-2 text-[0.85rem] cursor-pointer"><input type="checkbox" checked={onlyFeasible} onChange={e => setOnlyFeasible(e.target.checked)} /> Show feasible bases only</label>
          <div className="overflow-x-auto">
            <table className="tbl" aria-label="Basic solutions">
              <thead>
                <tr>
                  <th scope="col">#</th><th scope="col">Basic columns</th>
                  {res.colNames.map((n, j) => <th key={j} scope="col">{n}</th>)}
                  <th scope="col">Status</th>{res.twoVar && <th scope="col">({names[0]}, {names[1]})</th>}<th scope="col">z</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(b => (
                  <tr key={b.id} style={b.optimal ? { background: 'var(--ok-bg, rgba(16,185,129,.12))' } : b.status !== 'feasible' ? { opacity: b.status === 'singular' ? 0.55 : 0.8 } : undefined}>
                    <th scope="row">{b.id}</th>
                    <td className="mono">{b.basisNames.join(', ') || '—'}</td>
                    {res.colNames.map((_, j) => <td key={j}>{b.values ? (b.basisCols.includes(j) ? <span className={b.values[j]!.isNegative() ? 'font-bold' : ''} style={b.values[j]!.isNegative() ? { color: 'var(--bad)' } : undefined}><Q v={b.values[j]!} /></span> : <span className="muted">0</span>) : <span className="muted">—</span>}</td>)}
                    <td>
                      {b.status === 'singular' && <Badge title="the chosen columns are linearly dependent">not a basis</Badge>}
                      {b.status === 'infeasible' && <Badge kind="bad" title="a basic variable is negative">infeasible</Badge>}
                      {b.status === 'feasible' && <Badge kind="ok" title="all basic variables ≥ 0: an extreme point">BFS</Badge>}
                      {b.degenerate && <> <Badge kind="warn" title={`basic at zero: ${b.zeroBasics.join(', ')}`}>degenerate</Badge></>}
                      {b.optimal && <> <Badge kind="accent">optimal</Badge></>}
                    </td>
                    {res.twoVar && <td className="mono">{b.point ? <>(<Q v={b.point[0]!} />, <Q v={b.point[1]!} />)</> : '—'}</td>}
                    <td>{b.objective && b.status !== 'singular' ? <Q v={b.objective} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > shown.length && <div><Btn onClick={() => setAll(true)}>Show all {rows.length} rows</Btn></div>}
        </div>
      </Card>

      {res.twoVar && (
        <Card title="Corner points of the feasible polygon">
          {res.vertices.length === 0 ? <p className="text-sm muted">The feasible region is empty, so there are no corner points.</p> : (
            <>
              <p className="text-[0.9rem] mb-2">Each basic feasible solution is a corner of the polygon drawn on the Graphical tab ({res.vertices.length} distinct point{res.vertices.length === 1 ? '' : 's'}{res.vertices.length < res.counts.feasible ? `, reached by ${res.counts.feasible} bases because of degeneracy` : ''}).</p>
              <div className="overflow-x-auto">
                <table className="tbl" aria-label="Corner points">
                  <thead><tr><th scope="col">Corner</th><th scope="col">{names[0]}</th><th scope="col">{names[1]}</th><th scope="col">z</th><th scope="col">Bases</th></tr></thead>
                  <tbody>
                    {res.vertices.map((v, i) => (
                      <tr key={i} style={v.optimal ? { background: 'var(--ok-bg, rgba(16,185,129,.12))' } : undefined}>
                        <th scope="row">P{i + 1}{v.optimal && <> <Badge kind="accent">optimal</Badge></>}{v.degenerate && <> <Badge kind="warn">degenerate</Badge></>}</th>
                        <td><Q v={v.point[0]!} /></td><td><Q v={v.point[1]!} /></td><td><Q v={v.objective} /></td><td>{v.basisIds.map(id => `#${id}`).join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}
      {defCard}
    </div>
  );
}
