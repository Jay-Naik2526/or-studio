import { useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { LPModel } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { LPSolution } from '../../core/solvers/lp/engine';
import { SensitivityAnalyzer } from '../../core/solvers/lp/sensitivity';
import { Card, Callout, Badge, EmptyState } from '../ui/ui';
import { Q } from '../ui/Q';
import { RangeBar } from './RangeBar';

interface Props { model: LPModel; solution: LPSolution }

export function SensitivityView({ model, solution }: Props) {
  const res = solution.result;
  const [cost, setCost] = useState<Record<number, number>>({});
  const [rhs, setRhs] = useState<Record<number, number>>({});
  if (!res || !(solution.status === 'optimal' || solution.status === 'optimal-alternate-exists')) {
    return <Card title="Sensitivity analysis" icon={<BarChart3 size={14} />}><EmptyState>Sensitivity analysis needs an optimal solution.</EmptyState></Card>;
  }
  const rep = SensitivityAnalyzer.analyze(model, res);
  if (!rep.valid) return <Card title="Sensitivity analysis" icon={<BarChart3 size={14} />}><Callout kind="warn">{rep.reason}</Callout></Card>;

  const changes = {
    cost: Object.fromEntries(Object.entries(cost).map(([k, v]) => [Number(k), Rational.parse(String(Math.round(v * 1000) / 1000))])),
    rhs: Object.fromEntries(Object.entries(rhs).map(([k, v]) => [Number(k), Rational.parse(String(Math.round(v * 1000) / 1000))])),
  };
  const touched = Object.keys(cost).length + Object.keys(rhs).length > 0;
  const what = touched ? SensitivityAnalyzer.whatIf(model, changes, solution) : null;

  return (
    <div className="flex flex-col gap-3">
      <Card title="Shadow prices & right-hand-side ranging" icon={<BarChart3 size={14} />} right={<Badge>z = <Q v={res.objectiveValue} /></Badge>}>
        <div className="flex flex-col gap-4">
          {rep.shadowPrices.map((sp, k) => {
            const r = rep.rhsRanging[k]!;
            const cur = Number(r.range.current.toDecimal(6));
            const lo = r.range.min ? Number(r.range.min.toDecimal(6)) : cur - Math.max(5, Math.abs(cur));
            const hi = r.range.max ? Number(r.range.max.toDecimal(6)) : cur + Math.max(5, Math.abs(cur));
            const val = rhs[k] ?? cur;
            return (
              <div key={k} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-sm">{sp.name}</span>
                  <span className="text-[0.82rem] flex gap-2 items-center">
                    <Badge kind={sp.binding ? 'warn' : 'default'}>{sp.binding ? 'binding' : `slack ${sp.slack.toString()}`}</Badge>
                    <span>shadow price <b className="mono"><Q v={sp.shadowPrice} /></b></span>
                  </span>
                </div>
                <RangeBar label={sp.name} current={r.range.current} min={r.range.min} max={r.range.max} value={rhs[k]} />
                <div className="flex items-center gap-2 text-xs">
                  <span className="muted whitespace-nowrap">what-if RHS</span>
                  <input className="range" type="range" min={lo - (hi - lo) * 0.25} max={hi + (hi - lo) * 0.25} step={(hi - lo) / 200 || 0.1} value={val} aria-label={`What-if right-hand side of ${sp.name}`}
                    onChange={e => setRhs(s => ({ ...s, [k]: Number(e.target.value) }))} />
                  <span className="mono w-14 text-right">{Number(val.toFixed(2))}</span>
                </div>
                <p className="text-[13px] muted leading-snug">{sp.interpretation}</p>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Objective-coefficient ranging" icon={<BarChart3 size={14} />}>
        <div className="flex flex-col gap-4">
          {rep.objectiveRanging.map((o, j) => {
            const cur = Number(o.range.current.toDecimal(6));
            const lo = o.range.min ? Number(o.range.min.toDecimal(6)) : cur - Math.max(5, Math.abs(cur));
            const hi = o.range.max ? Number(o.range.max.toDecimal(6)) : cur + Math.max(5, Math.abs(cur));
            const val = cost[j] ?? cur;
            return (
              <div key={j} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-sm">{o.varName} = <span className="mono"><Q v={o.value} /></span></span>
                  <span className="text-[0.82rem] flex gap-2 items-center">
                    <Badge kind={o.isBasic ? 'ok' : 'default'}>{o.isBasic ? 'basic' : 'non-basic'}</Badge>
                    {o.reducedCost && <span>reduced cost <b className="mono"><Q v={o.reducedCost} /></b></span>}
                  </span>
                </div>
                {o.available ? (
                  <>
                    <RangeBar label={`Cost of ${o.varName}`} current={o.range.current} min={o.range.min} max={o.range.max} value={cost[j]} />
                    <div className="flex items-center gap-2 text-xs">
                      <span className="muted whitespace-nowrap">what-if cⱼ</span>
                      <input className="range" type="range" min={lo - (hi - lo) * 0.25} max={hi + (hi - lo) * 0.25} step={(hi - lo) / 200 || 0.1} value={val} aria-label={`What-if objective coefficient of ${o.varName}`} onChange={e => setCost(s => ({ ...s, [j]: Number(e.target.value) }))} />
                      <span className="mono w-14 text-right">{Number(val.toFixed(2))}</span>
                    </div>
                  </>
                ) : <p className="text-[13px] muted">{o.note}</p>}
              </div>
            );
          })}
        </div>
      </Card>

      {what && (
        <Card title="What-if result" icon={<RefreshCw size={14} />} right={<button className="btn btn-sm" onClick={() => { setCost({}); setRhs({}); }}>Reset sliders</button>}>
          {what.solution.result && what.solution.status !== 'unbounded' ? (
            <div className="flex flex-col gap-2 text-sm">
              <div>New optimum <b className="mono"><Q v={what.solution.result.objectiveValue} /></b> {what.objectiveDelta && <span className="muted">(change <span className="mono"><Q v={what.objectiveDelta} /></span>)</span>}</div>
              <div className="mono text-xs">{model.varNames.map((n, j) => <span key={j} className="mr-3">{n} = <Q v={what.solution.result!.variableValues[j]!} /></span>)}</div>
              <Callout kind={what.basisChanged ? 'warn' : 'ok'}>{what.basisChanged ? 'The optimal basis CHANGED: you have left the allowable range, so shadow prices and the old vertex no longer apply.' : 'Same optimal basis: the change stays inside the allowable range, so z changes linearly with the shadow price / basic value.'}</Callout>
            </div>
          ) : <Callout kind="bad">With these values the model is {what.solution.status}.</Callout>}
        </Card>
      )}
    </div>
  );
}
