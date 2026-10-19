import { useEffect, useMemo, useState } from 'react';
import { Repeat } from 'lucide-react';
import { LPModel } from '../../core/types/models';
import { solvePrimalDual, PDResult, PDState } from '../../core/solvers/lp/primalDual';
import { Card, Callout, Badge } from '../ui/ui';
import { Q } from '../ui/Q';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { clampStep } from '../modules/common';

export function usePrimalDual(model: LPModel | null): PDResult | null {
  return useMemo(() => {
    if (!model) return null;
    try { return solvePrimalDual(model); } catch (e) {
      return { status: 'invalid' as const, steps: [], problem: null, x: null, objective: null, y: null, iterations: 0, message: e instanceof Error ? e.message : 'The primal–dual run failed.' };
    }
  }, [model]);
}

const STATUS_LABEL: Record<string, string> = {
  optimal: 'Optimal', infeasible: 'Primal infeasible', 'no-dual-start': 'No dual-feasible start', 'iteration-limit': 'Iteration limit', cycling: 'Repeated dual vector', invalid: 'Invalid',
};

function PDTable({ s }: { s: PDState }) {
  const p = s.problem;
  const hot = new Set((s.direction?.blocking ?? []));
  const m = p.A.length;
  return (
    <div className="overflow-x-auto">
      <table className="tbl" aria-label="Primal–dual working table">
        <thead>
          <tr>
            <th scope="col" className="rowhead">Row</th>
            <th scope="col" title="current dual variable">y</th>
            {s.rp && <th scope="col" title="optimal dual of the restricted primal">w</th>}
            {p.colNames.map((n, j) => <th key={j} scope="col" className={hot.has(j) ? 'col-enter' : ''}>{n}{hot.has(j) && <div className="text-[13px] font-bold" style={{ color: 'var(--entering)' }}>▼ next</div>}</th>)}
            <th scope="col">b</th>
            {s.rp && <th scope="col" title="artificial variable value in the restricted primal">a</th>}
          </tr>
        </thead>
        <tbody>
          <tr className="zrow">
            <th scope="row">c (cost)</th><td className="zrow" />{s.rp && <td className="zrow" />}
            {p.c.map((v, j) => <td key={j} className="zrow"><Q v={v} /></td>)}<td className="zrow" />{s.rp && <td className="zrow" />}
          </tr>
          {s.reduced && (
            <tr className="zrow">
              <th scope="row" title="reduced cost d = c − y·A">d = c − yA</th><td className="zrow" />{s.rp && <td className="zrow" />}
              {s.reduced.map((v, j) => <td key={j} className="zrow" style={s.admissible?.[j] ? { color: 'var(--ok)', fontWeight: 700 } : undefined}><Q v={v} />{s.admissible?.[j] ? ' ✓' : ''}</td>)}
              <td className="zrow">{s.dualObjective ? <span title="dual objective b·y">w = <Q v={s.dualObjective} /></span> : null}</td>{s.rp && <td className="zrow" />}
            </tr>
          )}
          {s.rp && (
            <tr>
              <th scope="row" title="optimal x of the restricted primal (0 outside the admissible set)">x (restricted)</th><td />{<td />}
              {s.rp.x.map((v, j) => <td key={j}>{s.admissible?.[j] ? <Q v={v} /> : <span className="muted">—</span>}</td>)}<td /><td><span title="ξ = Σa">ξ = <Q v={s.rp.xi} /></span></td>
            </tr>
          )}
          {s.direction && (
            <tr>
              <th scope="row" title="w·A_j: positive entries outside the admissible set limit the step">w·A</th><td /><td />
              {s.direction.wA.map((v, j) => <td key={j} style={!s.admissible?.[j] && v.isPositive() ? { fontWeight: 700 } : undefined}><Q v={v} /></td>)}<td /><td />
            </tr>
          )}
          {p.A.map((row, i) => (
            <tr key={i}>
              <th scope="row">{p.rowLabels[i] ?? `row ${i + 1}`}</th>
              <td className="font-bold">{s.y ? <Q v={s.y[i]!} /> : <span className="muted">·</span>}</td>
              {s.rp && <td>{s.rp.w[i] ? <Q v={s.rp.w[i]!} /> : null}</td>}
              {row.map((v, j) => <td key={j} className={s.admissible?.[j] ? '' : s.admissible ? 'muted' : ''}><Q v={v} /></td>)}
              <td><Q v={p.b[i]!} /></td>
              {s.rp && <td><Q v={s.rp.art[i]!} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {m === 0 && <p className="text-sm muted">No constraints.</p>}
      {s.direction?.theta && s.direction.newY && (
        <p className="text-[0.85rem] mt-2">θ = <b className="mono"><Q v={s.direction.theta} /></b> &nbsp;→&nbsp; new y = ({s.direction.newY.map((v, i) => <span key={i}>{i > 0 ? ', ' : ''}<Q v={v} /></span>)})</p>
      )}
    </div>
  );
}

export function PrimalDualBody({ model }: { model: LPModel }) {
  const res = usePrimalDual(model);
  const [k, setK] = useState(0);
  const steps = res?.steps ?? [];
  useEffect(() => { setK(0); }, [model]);
  const idx = clampStep(k, steps.length);
  const cur = steps[idx];

  if (!res) return <Card title="Primal–dual algorithm" icon={<Repeat size={14} />}><p className="text-sm muted">Fix the model to run the primal–dual algorithm.</p></Card>;
  return (
    <div className="flex flex-col gap-3">
      <Card title="Primal–dual algorithm" icon={<Repeat size={14} />} right={<Badge kind={res.status === 'optimal' ? 'ok' : res.status === 'infeasible' ? 'bad' : 'warn'}>{STATUS_LABEL[res.status] ?? res.status}</Badge>}>
        <p className="text-[0.9rem] muted">
          Keeps a dual-feasible y and asks, at each round, whether the primal can be completed using only the columns whose dual constraint is tight (reduced cost 0). If not, y is moved along the direction w supplied by the restricted primal. Needs a dual-feasible start (all costs ≥ 0 in the min form gives y = 0).
        </p>
        {res.status === 'no-dual-start' && <div className="mt-3"><Callout kind="warn" title="Cannot start">{res.message}</Callout></div>}
        {(res.status === 'iteration-limit' || res.status === 'cycling' || res.status === 'invalid') && <div className="mt-3"><Callout kind="bad">{res.message}</Callout></div>}
        {res.status === 'optimal' && res.objective && res.x && (
          <div className="mt-3"><Callout kind="ok" title={`Optimal after ${res.iterations} round${res.iterations === 1 ? '' : 's'}`}>
            z = <b className="mono"><Q v={res.objective} /></b>; {model.varNames.map((n, j) => <span key={j} className="mono mr-3">{n} = <Q v={res.x![j]!} /></span>)}
          </Callout></div>
        )}
        {res.status === 'infeasible' && <div className="mt-3"><Callout kind="bad" title="Primal infeasible">{res.message}</Callout></div>}
      </Card>
      {cur && (
        <>
          <div className="eyebrow">Primal–dual walk-through (own step player)</div>
          <StepPlayer count={steps.length} index={idx} onChange={setK} labels={steps.map(s => s.phase ?? '')} summary={cur.explanation.short} keyboard={false} />
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-3 items-start [&>*]:min-w-0">
            <Card title={cur.phase ?? 'Step'} bodyClass="p-2">
              <PDTable s={cur.state} />
              <p className="text-[0.8rem] muted mt-2 px-1">Columns marked ✓ (reduced cost 0) are admissible. The restricted primal uses only those columns plus one artificial variable a per row.</p>
            </Card>
            <ExplanationPanel explanation={cur.explanation} phase={cur.phase} />
          </div>
        </>
      )}
    </div>
  );
}
