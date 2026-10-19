import { useMemo } from 'react';
import { ArrowLeftRight, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { LPModel } from '../../core/types/models';
import { dualityReport, formatWithSigns, signText, SOB_TABLE, DualBuild, DualityReport, MatrixForm, PairStatus } from '../../core/solvers/lp/duality';
import { Card, Callout, Badge, Collapsible } from '../ui/ui';
import { Q } from '../ui/Q';

const statusBadge = (s: PairStatus) => (
  <Badge kind={s === 'optimal' ? 'ok' : s === 'unknown' ? 'warn' : 'bad'}>{s === 'optimal' ? 'optimal' : s}</Badge>
);

function Mat({ mf, title }: { mf: MatrixForm; title: string }) {
  return (
    <div className="overflow-x-auto">
      <div className="eyebrow mb-1">{title}</div>
      <table className="tbl" aria-label={title}>
        <thead>
          <tr><th scope="col" className="rowhead">{mf.sense === 'max' ? 'max' : 'min'} c</th>{mf.varNames.map((n, j) => <th key={j} scope="col">{n}</th>)}<th scope="col" aria-label="relation" /><th scope="col">b</th></tr>
        </thead>
        <tbody>
          <tr className="zrow"><th scope="row">c</th>{mf.c.map((v, j) => <td key={j} className="zrow">{v}</td>)}<td className="zrow" /><td className="zrow" /></tr>
          {mf.A.map((row, i) => (
            <tr key={i}><th scope="row">A{i + 1}</th>{row.map((v, j) => <td key={j}>{v}</td>)}<td>{mf.rel[i]}</td><td>{mf.b[i]}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="text-[0.82rem] muted mt-1">{mf.signs.join(' · ')}</div>
    </div>
  );
}

export function DualityBody({ model }: { model: LPModel }) {
  const rep = useMemo<DualityReport | { ok: false; reason: string }>(() => {
    try { return dualityReport(model); } catch (e) { return { ok: false as const, reason: e instanceof Error ? e.message : 'The dual could not be built.' }; }
  }, [model]);
  if (!rep.ok) return <Card title="Duality" icon={<ArrowLeftRight size={14} />}><Callout kind="warn">{rep.reason}</Callout></Card>;
  const b: DualBuild = rep.build;
  const P = b.primal;
  const primalText = formatWithSigns(P, b.primalSigns, i => `(${i + 1})`);
  return (
    <div className="flex flex-col gap-3">
      <Card title="Dual formulation" icon={<ArrowLeftRight size={14} />} right={<Badge kind={rep.allHold ? 'ok' : 'bad'}>{rep.allHold ? 'all checks hold' : 'a check fails'}</Badge>}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 [&>*]:min-w-0">
          <div>
            <div className="eyebrow mb-1">Primal {b.addedRows.length || b.notes.some(n => n.includes('shifted')) ? '(after shifting bounds)' : ''}</div>
            <pre className="mono text-[0.85rem] whitespace-pre-wrap rounded-md p-2" style={{ background: 'var(--surface-2)' }} aria-label="Primal problem">{primalText}</pre>
          </div>
          <div>
            <div className="eyebrow mb-1">Dual</div>
            <pre className="mono text-[0.85rem] whitespace-pre-wrap rounded-md p-2" style={{ background: 'var(--surface-2)' }} aria-label="Dual problem">{b.displayText}</pre>
          </div>
        </div>
        <ul className="list-disc pl-4 text-[0.82rem] mt-3 flex flex-col gap-1">{b.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        <p className="text-[0.82rem] muted mt-2">Each dual constraint is labelled with the primal variable it belongs to; each dual variable y is the shadow price of the primal constraint with the same number. The dual of this dual is the primal again.</p>
      </Card>

      <Card title="Correspondence table">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 [&>*]:min-w-0">
          <div className="overflow-x-auto">
            <table className="tbl" aria-label="Primal constraints and dual variables">
              <thead><tr><th scope="col">Primal constraint</th><th scope="col">Type</th><th scope="col">Dual variable</th><th scope="col">Sign</th></tr></thead>
              <tbody>
                {b.correspondence.constraints.map(c => (
                  <tr key={c.index} title={c.note}><th scope="row">{c.label}</th><td>{c.relation === '<=' ? '≤' : c.relation === '>=' ? '≥' : '='}</td><td className="font-bold">{c.dualVar}</td><td>{signText(c.dualSign)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl" aria-label="Primal variables and dual constraints">
              <thead><tr><th scope="col">Primal variable</th><th scope="col">Sign</th><th scope="col">Dual constraint</th><th scope="col">Relation</th></tr></thead>
              <tbody>
                {b.correspondence.variables.map(v => (
                  <tr key={v.index} title={v.note}><th scope="row">{v.name}</th><td>{signText(v.sign)}</td><td>row {v.index + 1}</td><td className="font-bold">{v.dualRelation === '<=' ? '≤' : v.dualRelation === '>=' ? '≥' : '='}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <Collapsible title="Rules used (SOB table)">
          <div className="overflow-x-auto">
            <table className="tbl" aria-label="Primal-dual rules"><thead><tr><th scope="col">Primal</th><th scope="col">Dual</th></tr></thead>
              <tbody>{SOB_TABLE.map((r, i) => <tr key={i}><td>{r.primal}</td><td>{r.dual}</td></tr>)}</tbody></table>
          </div>
        </Collapsible>
        <div className="mt-3"><Collapsible title="Matrix form">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 [&>*]:min-w-0">
            <Mat mf={b.matrixPrimal} title={`Primal: ${b.matrixPrimal.sense} cᵀx, A x (rel) b`} />
            <Mat mf={b.matrixDual} title={`Dual: ${b.matrixDual.sense} bᵀy, Aᵀy (rel) c`} />
          </div>
        </Collapsible></div>
      </Card>

      <Card title="Both solutions side by side">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 [&>*]:min-w-0">
          <div>
            <div className="flex items-center gap-2 mb-1"><span className="eyebrow">Primal</span>{statusBadge(rep.primalStatus)}</div>
            {rep.x && rep.primalValue ? (
              <table className="tbl" aria-label="Primal solution"><tbody>
                {model.varNames.map((nm, j) => <tr key={j}><th scope="row">{nm}</th><td className="font-bold"><Q v={rep.x![j]!} /></td></tr>)}
                <tr className="zrow"><th scope="row">z*</th><td className="zrow"><Q v={rep.primalValue} /></td></tr>
              </tbody></table>
            ) : <p className="text-sm muted">No primal optimum.</p>}
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1"><span className="eyebrow">Dual</span>{statusBadge(rep.dualStatus)}</div>
            {rep.y && rep.dualValue ? (
              <table className="tbl" aria-label="Dual solution"><tbody>
                {rep.y.map((v, i) => <tr key={i}><th scope="row">{b.dual.varNames[i]} <span className="muted font-normal">({b.correspondence.constraints[i]?.label})</span></th><td className="font-bold"><Q v={v} /></td></tr>)}
                <tr className="zrow"><th scope="row">w*</th><td className="zrow"><Q v={rep.dualValue} /></td></tr>
              </tbody></table>
            ) : <p className="text-sm muted">No dual optimum.</p>}
          </div>
        </div>
        <div className="mt-3"><Callout kind={rep.pairing.consistent ? 'info' : 'bad'} title="Pairing of outcomes">{rep.pairing.text}</Callout></div>
      </Card>

      <Card title="Duality checks">
        <div className="overflow-x-auto">
          <table className="tbl" aria-label="Duality checks">
            <thead><tr><th scope="col" style={{ width: 36 }}>OK</th><th scope="col">Check</th><th scope="col">Detail</th></tr></thead>
            <tbody>
              {rep.checks.map(c => (
                <tr key={c.id}>
                  <td>{c.holds === true ? <CheckCircle2 size={16} style={{ color: 'var(--ok)' }} aria-label="holds" /> : c.holds === false ? <XCircle size={16} style={{ color: 'var(--bad)' }} aria-label="fails" /> : <MinusCircle size={16} className="muted" aria-label="not applicable" />}</td>
                  <th scope="row">{c.label}</th>
                  <td className="text-[0.85rem]">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rep.cs.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <div className="eyebrow mb-1">Complementary slackness — every product must be 0</div>
            <table className="tbl" aria-label="Complementary slackness">
              <thead><tr><th scope="col">Pair</th><th scope="col">First factor</th><th scope="col">Second factor</th><th scope="col">Product</th><th scope="col">OK</th></tr></thead>
              <tbody>
                {rep.cs.map((r, i) => (
                  <tr key={i}>
                    <th scope="row">{r.kind === 'constraint' ? `${r.label}: slack × ${r.rightName}` : `${r.label}: reduced cost × ${r.rightName}`}</th>
                    <td><Q v={r.left} /></td><td><Q v={r.right} /></td><td><Q v={r.left.mul(r.right)} /></td>
                    <td>{r.holds ? <CheckCircle2 size={14} style={{ color: 'var(--ok)' }} aria-label="holds" /> : <XCircle size={14} style={{ color: 'var(--bad)' }} aria-label="fails" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[0.82rem] muted mt-2">Reading it: if a constraint has slack (it is not binding) its shadow price must be 0; if a variable is positive its dual constraint must be tight (reduced cost 0).</p>
          </div>
        )}
      </Card>

      {rep.shadow.length > 0 && (
        <Card title="What the dual variables mean (shadow prices)">
          <ul className="list-disc pl-4 text-[0.9rem] flex flex-col gap-1.5">
            {rep.shadow.map((s, i) => <li key={i}>{s.text}</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}
