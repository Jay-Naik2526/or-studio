import { TransportState } from '../../core/types/models';
import { Highlight } from '../../core/types/step';
import { Q, QM } from '../ui/Q';

interface Props { state: TransportState; highlights?: Highlight[]; supply: string[]; demand: string[]; hideEval?: boolean }

/** Allocation grid: unit cost in the corner, allocation in the cell, u/v duals, improvement indices and the closed loop. */
export function TransportGrid({ state, highlights = [], supply, demand, hideEval }: Props) {
  const n = state.allocations[0]?.length ?? 0;
  const loop = new Map((hideEval ? [] : state.loop ?? []).map(c => [`${c.row},${c.col}`, c.sign]));
  const hl = new Set(highlights.map(h => h.target));
  const dummyRow = state.dummyRow, dummyCol = state.dummyCol;
  const entering = hideEval ? undefined : state.enteringCell;
  const showUV = !hideEval && !!state.u;
  return (
    <div className="overflow-x-auto">
      <table className="tbl" aria-label="Transportation allocation grid">
        <caption className="sr-only">Allocation grid; each cell shows the unit cost and the quantity shipped.</caption>
        <thead>
          <tr>
            <th scope="col" className="rowhead" />
            {Array.from({ length: n }, (_, j) => <th key={j} scope="col" style={j === dummyCol ? { fontStyle: 'italic', background: 'var(--warn-soft)' } : undefined}>{state.colLabels?.[j] ?? `D${j + 1}`}{j === dummyCol && <div className="text-[13px]">dummy</div>}{showUV && <div className="text-[12px] font-normal muted">v = <QM v={state.v![j]!} /></div>}</th>)}
            <th scope="col">Supply</th>
            {showUV && <th scope="col" className="muted">u</th>}
          </tr>
        </thead>
        <tbody>
          {state.allocations.map((row, i) => (
            <tr key={i}>
              <th scope="row" style={i === dummyRow ? { fontStyle: 'italic', background: 'var(--warn-soft)' } : undefined}>{state.rowLabels?.[i] ?? `S${i + 1}`}{i === dummyRow && <span className="text-[13px] ml-1">dummy</span>}</th>
              {row.map((a, j) => {
                const sign = loop.get(`${i},${j}`);
                const isEnter = entering && entering.row === i && entering.col === j;
                const idx = !hideEval ? state.improvementIndices?.[i]?.[j] : null;
                const crossed = (state.crossedRows?.[i] || state.crossedCols?.[j]) && a === null && !hideEval;
                const cls = [sign ? (sign === '+' ? 'col-enter' : 'row-leave') : '', isEnter ? 'pivot' : '', hl.has(`cell:${i},${j}`) && !sign ? 'changed' : '', a !== null && !sign ? 'basic' : '', state.costs?.[i]?.[j]?.hasM() ? 'blocked' : ''].join(' ');
                return (
                  <td key={j} className={cls} style={{ minWidth: 76, height: 52 }}>
                    <div className="absolute top-0.5 right-1 text-[12px] opacity-70"><QM v={state.costs?.[i]?.[j]} /></div>
                    {a !== null ? <span className="text-sm font-extrabold">{a.isZero() ? <span title="ε: basic cell with zero allocation (degenerate)">ε</span> : <Q v={a} />}</span> : <span className="muted">{crossed ? '' : ''}</span>}
                    {sign && <span className="absolute bottom-0.5 left-1 text-[0.82rem] font-extrabold" aria-label={sign === '+' ? 'plus' : 'minus'}>{sign === '+' ? '＋' : '－'}</span>}
                    {idx && a === null && <div className="absolute bottom-0.5 right-1 text-[12px]" style={{ color: idx.isNegative() ? 'var(--bad)' : 'var(--text-3)' }} title="improvement index cᵢⱼ − uᵢ − vⱼ">Δ=<QM v={idx} /></div>}
                  </td>
                );
              })}
              <td className="font-bold">{supply[i] ?? ''}{state.supplyLeft && !hideEval && <div className="text-[12px] muted font-normal">left <Q v={state.supplyLeft[i]!} /></div>}</td>
              {showUV && <td className="muted"><QM v={state.u![i]!} /></td>}
            </tr>
          ))}
          <tr>
            <th scope="row">Demand</th>
            {Array.from({ length: n }, (_, j) => <td key={j} className="font-bold">{demand[j] ?? ''}{state.demandLeft && !hideEval && <div className="text-[12px] muted font-normal">left <Q v={state.demandLeft[j]!} /></div>}</td>)}
            <td className="zrow" colSpan={showUV ? 2 : 1}>cost <QM v={state.totalCost} /></td>
          </tr>
          {state.rowPenalty && !hideEval && (
            <tr><th scope="row" title="Vogel penalties">penalty</th>{Array.from({ length: n }, (_, j) => <td key={j} className="muted">{state.colPenalty?.[j] ? <QM v={state.colPenalty[j]} /> : ''}</td>)}<td colSpan={2} className="muted text-[12px]">rows: {state.rowPenalty.map((p, i) => (p ? `${state.rowLabels?.[i]}=${p.toString()}` : null)).filter(Boolean).join(' ')}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
