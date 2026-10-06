import { useMemo, useState } from 'react';
import { Code2, Table2, AlertCircle, Plus, Trash2, Play, CheckCircle2 } from 'lucide-react';
import { AlgebraicParser, formatLP } from '../../core/parse/algebraic';
import { LPModel, Relation, Constraint, VarType, Bound } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { canonVarName } from '../../core/format';
import { parseNum } from '../../lib/numbers';
import { Btn, Card, Segmented, Callout } from '../ui/ui';

export interface LPExample { label: string; text: string }

interface Props {
  text: string;
  onText: (t: string) => void;
  model: LPModel | null;
  error: { line: number; col: number; message: string } | null;
  warnings?: { line: number; col: number; message: string }[];
  examples?: LPExample[];
  /** show integer / binary controls (integer programming module) */
  integerControls?: boolean;
  title?: string;
}

type VarKind = 'nonneg' | 'free' | 'int' | 'bin';

export function LPInput({ text, onText, model, error, warnings, examples, integerControls, title = 'Model' }: Props) {
  const [mode, setMode] = useState<'text' | 'form'>('text');
  const lines = text.split('\n');

  const frame = useMemo(() => {
    if (!error) return null;
    const l = lines[error.line - 1] ?? '';
    return { l, caret: ' '.repeat(Math.max(0, error.col - 1)) + '^' };
  }, [error, text]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card title={title} icon={mode === 'text' ? <Code2 size={14} /> : <Table2 size={14} />}
      right={<Segmented label="Input method" value={mode} onChange={setMode} options={[{ value: 'text', label: 'Text' }, { value: 'form', label: 'Form' }]} />}>
      <div className="flex flex-col gap-3">
        {examples && examples.length > 0 && (
          <label className="flex items-center gap-2 text-xs">
            <span className="muted">Example</span>
            <select className="select" value="" onChange={e => { const ex = examples[Number(e.target.value)]; if (ex) onText(ex.text); }} aria-label="Load an example">
              <option value="" disabled>Choose…</option>
              {examples.map((x, i) => <option key={i} value={i}>{x.label}</option>)}
            </select>
          </label>
        )}
        {mode === 'text' ? (
          <div className="flex flex-col gap-2">
            <div className="relative">
              <textarea
                className="textarea mono"
                rows={Math.min(14, Math.max(7, lines.length + 1))}
                value={text}
                spellCheck={false}
                aria-label="Model in algebraic notation"
                aria-invalid={!!error}
                aria-describedby="lp-text-status"
                onChange={e => onText(e.target.value)}
                placeholder={'max 3x1 + 5x2\nsubject to\n  x1 <= 4\n  2x2 <= 12\n  3x1 + 2x2 <= 18\n  x1, x2 >= 0'}
              />
            </div>
            <div id="lp-text-status" role="status">
              {error ? (
                <div className="callout callout-bad" role="alert">
                  <AlertCircle size={15} className="shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Line {error.line}, column {error.col}: {error.message}</div>
                    {frame && <pre className="mono text-[13px] mt-1 overflow-x-auto" style={{ margin: 0 }}>{frame.l}{'\n'}{frame.caret}</pre>}
                  </div>
                </div>
              ) : model ? (
                <div className="text-[0.82rem] flex items-center gap-1.5" style={{ color: 'var(--ok)' }}><CheckCircle2 size={13} /> {model.objective.length} variables, {model.constraints.length} constraints — parsed.</div>
              ) : null}
              {warnings?.map((w, i) => <div key={i} className="text-[0.82rem] mt-1" style={{ color: 'var(--warn)' }}>⚠ {w.message}</div>)}
            </div>
            <details className="text-[0.82rem] muted">
              <summary className="cursor-pointer">Notation help</summary>
              <ul className="list-disc pl-5 mt-1 flex flex-col gap-0.5">
                <li><code>max</code> / <code>min</code> then the objective; constraints after <code>st</code>, <code>s.t.</code> or <code>subject to</code>.</li>
                <li>Relations <code>&lt;=</code> <code>≤</code> <code>=&lt;</code> <code>&gt;=</code> <code>≥</code> <code>=</code>; <code>x1, x2 &gt;= 0</code> is implied.</li>
                <li>Implicit coefficients (<code>x1</code> = 1·x₁), fractions <code>1/2x</code>, variables on both sides, <code>a &lt;= expr &lt;= b</code>.</li>
                <li>Declarations: <code>free x3</code>, <code>int x1, x2</code>, <code>bin x4</code>. Name a row with <code>labour: …</code>.</li>
              </ul>
            </details>
          </div>
        ) : (
          model ? <LPForm model={model} onModel={m => onText(formatLP(m))} integerControls={integerControls} /> : <Callout kind="warn">Fix the text model first (switch to Text) — the form needs a valid model.</Callout>
        )}
      </div>
    </Card>
  );
}

function kindOf(m: LPModel, j: number): VarKind {
  if (m.integrality?.[j] === 'binary') return 'bin';
  if (m.varBounds?.[j] && m.varBounds[j]!.lower === null) return 'free';
  if (m.integrality?.[j] === 'integer') return 'int';
  return 'nonneg';
}

function LPForm({ model, onModel, integerControls }: { model: LPModel; onModel: (m: LPModel) => void; integerControls?: boolean }) {
  const n = model.objective.length;
  const set = (patch: Partial<LPModel>) => onModel({ ...model, ...patch });
  const cell = (r: Rational) => r.toString();
  const edit = (cur: Rational, s: string): Rational => { const p = parseNum(s); return p.ok ? p.value : cur; };

  const setKind = (j: number, k: VarKind) => {
    const bounds: Bound[] = model.varNames.map((_, i) => model.varBounds?.[i] ?? { lower: Rational.ZERO, upper: null });
    const integ: VarType[] = model.varNames.map((_, i) => model.integrality?.[i] ?? 'continuous');
    bounds[j] = k === 'free' ? { lower: null, upper: null } : k === 'bin' ? { lower: Rational.ZERO, upper: Rational.ONE } : { lower: Rational.ZERO, upper: null };
    integ[j] = k === 'int' ? 'integer' : k === 'bin' ? 'binary' : 'continuous';
    const anyBounds = bounds.some(b => b.lower === null || b.upper !== null);
    const anyInt = integ.some(x => x !== 'continuous');
    onModel({ ...model, varBounds: anyBounds ? bounds : undefined, integrality: anyInt ? integ : undefined });
  };
  const addVar = () => {
    const name = canonVarName(`x${n + 1}`);
    onModel({
      ...model,
      varNames: [...model.varNames, name],
      objective: [...model.objective, Rational.ZERO],
      constraints: model.constraints.map(c => ({ ...c, coeffs: [...c.coeffs, Rational.ZERO] })),
      varBounds: model.varBounds ? [...model.varBounds, { lower: Rational.ZERO, upper: null }] : undefined,
      integrality: model.integrality ? [...model.integrality, 'continuous'] : undefined,
    });
  };
  const delVar = () => {
    if (n <= 1) return;
    onModel({
      ...model,
      varNames: model.varNames.slice(0, -1),
      objective: model.objective.slice(0, -1),
      constraints: model.constraints.map(c => ({ ...c, coeffs: c.coeffs.slice(0, -1) })),
      varBounds: model.varBounds?.slice(0, -1),
      integrality: model.integrality?.slice(0, -1),
    });
  };
  const upd = (i: number, patch: Partial<Constraint>) => set({ constraints: model.constraints.map((c, k) => (k === i ? { ...c, ...patch } : c)) });

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5">Objective
          <select className="select !w-auto" value={model.sense} onChange={e => set({ sense: e.target.value as 'max' | 'min' })}>
            <option value="max">Maximise</option><option value="min">Minimise</option>
          </select>
        </label>
        <span className="flex items-center gap-1">Variables
          <Btn size="icon" aria-label="Remove variable" onClick={delVar} disabled={n <= 1}>−</Btn><span className="mono w-4 text-center">{n}</span><Btn size="icon" aria-label="Add variable" onClick={addVar} disabled={n >= 12}><Plus size={12} /></Btn>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl" aria-label="Linear programme">
          <thead>
            <tr><th className="rowhead" scope="col">Row</th>{model.varNames.map((v, j) => <th key={j} scope="col" className="!p-0.5"><input className="input num !w-14" aria-label={`Name of variable ${j + 1}`} value={v} onChange={e => set({ varNames: model.varNames.map((x, k) => (k === j ? canonVarName(e.target.value.replace(/\s/g, '')) : x)) })} /></th>)}<th scope="col">Rel</th><th scope="col">RHS</th><th scope="col"><span className="sr-only">Remove</span></th></tr>
          </thead>
          <tbody>
            <tr className="zrow">
              <th scope="row">{model.sense === 'max' ? 'max z' : 'min z'}</th>
              {model.objective.map((c, j) => <td key={j} className="!p-0.5"><input className="input num" aria-label={`Objective coefficient of ${model.varNames[j]}`} defaultValue={cell(c)} key={cell(c)} onBlur={e => set({ objective: model.objective.map((x, k) => (k === j ? edit(x, e.target.value) : x)) })} /></td>)}
              <td colSpan={3} />
            </tr>
            {model.constraints.map((c, i) => (
              <tr key={i}>
                <th scope="row">{c.name || `(${i + 1})`}</th>
                {c.coeffs.map((a, j) => <td key={j} className="!p-0.5"><input className="input num" aria-label={`Constraint ${i + 1}, ${model.varNames[j]}`} defaultValue={cell(a)} key={cell(a)} onBlur={e => upd(i, { coeffs: c.coeffs.map((x, k) => (k === j ? edit(x, e.target.value) : x)) })} /></td>)}
                <td className="!p-0.5"><select className="select !w-14" aria-label={`Relation of constraint ${i + 1}`} value={c.relation} onChange={e => upd(i, { relation: e.target.value as Relation })}><option value="<=">≤</option><option value=">=">≥</option><option value="=">=</option></select></td>
                <td className="!p-0.5"><input className="input num" aria-label={`Right-hand side of constraint ${i + 1}`} defaultValue={cell(c.rhs)} key={cell(c.rhs)} onBlur={e => upd(i, { rhs: edit(c.rhs, e.target.value) })} /></td>
                <td className="!p-0.5"><Btn size="icon" variant="ghost" aria-label={`Delete constraint ${i + 1}`} onClick={() => set({ constraints: model.constraints.filter((_, k) => k !== i) })}><Trash2 size={13} /></Btn></td>
              </tr>
            ))}
            <tr>
              <th scope="row">Type</th>
              {model.varNames.map((_, j) => (
                <td key={j} className="!p-0.5">
                  <select className="select !w-16" aria-label={`Type of ${model.varNames[j]}`} value={kindOf(model, j)} onChange={e => setKind(j, e.target.value as VarKind)}>
                    <option value="nonneg">≥ 0</option><option value="free">free</option>
                    {(integerControls || model.integrality) && <><option value="int">int</option><option value="bin">bin</option></>}
                  </select>
                </td>
              ))}
              <td colSpan={3} />
            </tr>
          </tbody>
        </table>
      </div>
      <div><Btn onClick={() => set({ constraints: [...model.constraints, { coeffs: Array(n).fill(Rational.ZERO), relation: '<=', rhs: Rational.ZERO }] })}><Plus size={13} /> Add constraint</Btn></div>
    </div>
  );
}

export function parseLPText(text: string): { model: LPModel | null; error: { line: number; col: number; message: string } | null; warnings?: { line: number; col: number; message: string }[] } {
  const r = AlgebraicParser.parse(text);
  return r.success && r.model ? { model: r.model, error: null, warnings: r.warnings } : { model: null, error: r.error ?? { line: 1, col: 1, message: 'Parse error' } };
}

export { Play };
