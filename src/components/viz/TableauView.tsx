import { Tableau } from '../../core/types/models';
import { Highlight } from '../../core/types/step';
import { Rational } from '../../core/math/rational';
import { MNum } from '../../core/math/bigm';
import { Q, QM } from '../ui/Q';

interface Props {
  tableau: Tableau;
  highlights?: Highlight[];
  /** hide the upcoming-pivot overlay (tutor mode) */
  hideNext?: boolean;
  caption?: string;
}

/** Simplex tableau with entering column / leaving row / pivot cell, ratio column and exact stacked fractions. */
export function TableauView({ tableau: t, highlights = [], hideNext, caption }: Props) {
  const np = hideNext ? undefined : t.nextPivot;
  const changedRows = new Set(highlights.filter(h => h.intent === 'changed' && h.target.startsWith('row:')).map(h => Number(h.target.slice(4))));
  const optCells = new Set(highlights.filter(h => h.intent === 'optimal').map(h => h.target));
  const blockedCol = highlights.find(h => h.intent === 'blocked' && h.target.startsWith('col:'));
  const blockedRow = highlights.find(h => h.intent === 'blocked' && h.target.startsWith('row:'));
  const enterCol = np ? np.enteringCol : blockedCol ? Number(blockedCol.target.slice(4)) : -1;
  const leaveRow = np ? np.leavingRow : -1;
  const hasRatio = np && !np.colRatios && np.ratios.some(r => r);
  const label = t.objectiveLabel ?? 'z';
  const z = (j: number) => (t.bigMRow ? <QM v={new MNum(t.objectiveRow[j]!, t.bigMRow[j]!)} /> : <Q v={t.objectiveRow[j]!} />);
  const zv = t.bigMRow ? <QM v={new MNum(t.objectiveValue, t.objectiveValueM ?? Rational.ZERO)} /> : <Q v={t.objectiveValue} />;

  return (
    <div className="overflow-x-auto">
      <table className="tbl" aria-label={caption ?? 'Simplex tableau'}>
        <caption className="sr-only">{caption ?? 'Simplex tableau'}{np ? `. Next pivot: ${t.columnNames[np.enteringCol]} enters, row of ${t.columnNames[t.basis[np.leavingRow]!]} leaves.` : ''}</caption>
        <thead>
          <tr>
            <th scope="col" className="rowhead">Basis</th>
            {t.columnNames.map((n, j) => (
              <th key={j} scope="col" className={j === enterCol ? 'col-enter' : ''} title={t.columnTypes[j]}>
                {n}
                {j === enterCol && <div className="text-[13px] font-bold" style={{ color: 'var(--entering)' }}>{blockedCol ? '⊘ unbounded' : '▼ enters'}</div>}
              </th>
            ))}
            <th scope="col">RHS</th>
            {hasRatio && <th scope="col" title="RHS ÷ pivot-column entry (positive entries only)">Ratio</th>}
          </tr>
        </thead>
        <tbody>
          <tr className="zrow">
            <th scope="row">{label}</th>
            {t.objectiveRow.map((_, j) => <td key={j} className={`zrow ${j === enterCol ? 'col-enter' : ''} ${(t.bigMRow ? new MNum(t.objectiveRow[j]!, t.bigMRow[j]!).isNegative() : t.objectiveRow[j]!.isNegative()) ? 'neg' : ''}`}>{z(j)}</td>)}
            <td className="zrow">{zv}</td>
            {hasRatio && <td />}
          </tr>
          {t.matrix.map((row, i) => {
            const leaving = i === leaveRow;
            return (
              <tr key={i}>
                <th scope="row" className={`${leaving ? 'row-leave' : ''}`}>
                  {t.columnNames[t.basis[i]!]}
                  {leaving && <span className="text-[13px] font-bold ml-1" style={{ color: 'var(--leaving)' }}>◀ leaves</span>}
                  {blockedRow && blockedRow.target === `row:${i}` && <span className="text-[13px] font-bold ml-1" style={{ color: 'var(--bad)' }}>⊘</span>}
                </th>
                {row.map((v, j) => {
                  const piv = np && i === np.leavingRow && j === np.enteringCol;
                  const basic = t.basis[i] === j;
                  const cls = [piv ? 'pivot' : j === enterCol ? 'col-enter' : leaving ? 'row-leave' : '', basic ? 'basic' : '', changedRows.has(i) && !basic ? 'changed' : '', optCells.has(`cell:${i},${j}`) ? 'opt' : ''].join(' ');
                  return <td key={j} className={cls}><Q v={v} /></td>;
                })}
                <td className={`${leaving ? 'row-leave' : ''} font-bold ${t.rhs[i]!.isNegative() ? 'neg' : ''}`}><Q v={t.rhs[i]!} /></td>
                {hasRatio && <td className={leaving ? 'row-leave' : ''}>{np!.ratios[i] ? <><Q v={np!.ratios[i]} />{np!.tiedRows.length > 1 && np!.tiedRows.includes(i) && <span title="tied" style={{ color: 'var(--warn)' }}> ≡</span>}</> : <span className="muted" title="entry ≤ 0: not eligible">—</span>}</td>}
              </tr>
            );
          })}
          {np?.colRatios && (
            <tr>
              <th scope="row" title="|z-row entry| ÷ |pivot-row entry|">ratio</th>
              {np.colRatios.map((r, j) => <td key={j} className={j === np.enteringCol ? 'col-enter' : ''}>{r ? <Q v={r} /> : <span className="muted">—</span>}</td>)}
              <td /><td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
