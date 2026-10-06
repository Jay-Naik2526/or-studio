import { ClipboardEvent, useId } from 'react';
import { Plus, Minus, Upload } from 'lucide-react';
import { parseNum } from '../../lib/numbers';
import { parseMatrixText } from '../../lib/persist';
import { Btn } from '../ui/ui';

export const isBlocked = (s: string) => /^(m|x|inf|∞|-|blocked)$/i.test(s.trim());

interface Props {
  values: string[][];
  onChange: (v: string[][]) => void;
  rowLabels?: string[];
  colLabels?: string[];
  onRowLabels?: (l: string[]) => void;
  onColLabels?: (l: string[]) => void;
  caption: string;
  /** extra header column (e.g. Supply) and row (e.g. Demand) */
  rowExtra?: { label: string; values: string[]; onChange: (v: string[]) => void };
  colExtra?: { label: string; values: string[]; onChange: (v: string[]) => void };
  resizable?: boolean;
  minRows?: number;
  minCols?: number;
  maxRows?: number;
  maxCols?: number;
  /** cells may be "M"/"x" meaning a prohibited route / assignment */
  allowBlocked?: boolean;
  square?: boolean;
  /** fixed numeric validation: allow only non-negative */
  nonNegative?: boolean;
  cornerLabel?: string;
}

export function MatrixEditor(p: Props) {
  const uid = useId();
  const rows = p.values.length;
  const cols = p.values[0]?.length ?? 0;
  const setCell = (i: number, j: number, v: string) => p.onChange(p.values.map((r, ii) => (ii === i ? r.map((c, jj) => (jj === j ? v : c)) : r)));
  const rl = (i: number) => p.rowLabels?.[i] ?? `R${i + 1}`;
  const cl = (j: number) => p.colLabels?.[j] ?? `C${j + 1}`;
  const invalid = (s: string) => {
    if (s.trim() === '') return true;
    if (p.allowBlocked && isBlocked(s)) return false;
    const r = parseNum(s);
    return !r.ok || (p.nonNegative === true && r.value.isNegative());
  };

  const addRow = () => {
    p.onChange([...p.values, Array(cols).fill('0')]);
    p.onRowLabels?.([...(p.rowLabels ?? []), `R${rows + 1}`]);
    p.rowExtra?.onChange([...p.rowExtra.values, '0']);
  };
  const addCol = () => {
    p.onChange(p.values.map(r => [...r, '0']));
    p.onColLabels?.([...(p.colLabels ?? []), `C${cols + 1}`]);
    p.colExtra?.onChange([...p.colExtra.values, '0']);
  };
  const delRow = () => {
    p.onChange(p.values.slice(0, -1));
    p.onRowLabels?.((p.rowLabels ?? []).slice(0, -1));
    p.rowExtra?.onChange(p.rowExtra.values.slice(0, -1));
  };
  const delCol = () => {
    p.onChange(p.values.map(r => r.slice(0, -1)));
    p.onColLabels?.((p.colLabels ?? []).slice(0, -1));
    p.colExtra?.onChange(p.colExtra.values.slice(0, -1));
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>, i: number, j: number) => {
    const text = e.clipboardData.getData('text');
    if (!/[\n\t,;]/.test(text)) return;
    e.preventDefault();
    const grid = parseMatrixText(text);
    if (!grid.length) return;
    const next = p.values.map(r => [...r]);
    const needRows = Math.min(p.maxRows ?? 30, i + grid.length);
    const needCols = Math.min(p.maxCols ?? 30, j + Math.max(...grid.map(g => g.length)));
    while (next.length < needRows) next.push(Array(next[0]?.length ?? cols).fill('0'));
    next.forEach(r => { while (r.length < needCols) r.push('0'); });
    grid.forEach((g, a) => g.forEach((v, b) => { if (next[i + a]?.[j + b] !== undefined) next[i + a]![j + b] = v; }));
    p.onChange(next);
    if (p.onRowLabels && next.length > rows) p.onRowLabels(Array.from({ length: next.length }, (_, k) => p.rowLabels?.[k] ?? `R${k + 1}`));
    if (p.onColLabels && (next[0]?.length ?? 0) > cols) p.onColLabels(Array.from({ length: next[0]!.length }, (_, k) => p.colLabels?.[k] ?? `C${k + 1}`));
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const g = parseMatrixText(await f.text());
    if (g.length && g.every(r => r.length === g[0]!.length)) {
      p.onChange(g);
      p.onRowLabels?.(Array.from({ length: g.length }, (_, k) => p.rowLabels?.[k] ?? `R${k + 1}`));
      p.onColLabels?.(Array.from({ length: g[0]!.length }, (_, k) => p.colLabels?.[k] ?? `C${k + 1}`));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto pb-1">
        <table className="tbl" aria-label={p.caption}>
          <caption className="sr-only">{p.caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="rowhead">{p.cornerLabel ?? ''}</th>
              {Array.from({ length: cols }, (_, j) => (
                <th key={j} scope="col" className="!p-0.5">
                  {p.onColLabels ? <input className="input num !w-[3.7rem]" aria-label={`Name of column ${j + 1}`} value={p.colLabels?.[j] ?? ''} onChange={e => p.onColLabels!((p.colLabels ?? []).map((l, k) => (k === j ? e.target.value : l)))} /> : cl(j)}
                </th>
              ))}
              {p.rowExtra && <th scope="col">{p.rowExtra.label}</th>}
            </tr>
          </thead>
          <tbody>
            {p.values.map((row, i) => (
              <tr key={i}>
                <th scope="row" className="!p-0.5">
                  {p.onRowLabels ? <input className="input !w-[4.6rem]" aria-label={`Name of row ${i + 1}`} value={p.rowLabels?.[i] ?? ''} onChange={e => p.onRowLabels!((p.rowLabels ?? []).map((l, k) => (k === i ? e.target.value : l)))} /> : rl(i)}
                </th>
                {row.map((v, j) => (
                  <td key={j} className="!p-0.5">
                    <input
                      id={`${uid}-${i}-${j}`}
                      className="input num !min-w-[3rem] !w-[3.7rem]"
                      inputMode="decimal"
                      value={v}
                      aria-label={`${p.caption}: ${rl(i)}, ${cl(j)}`}
                      aria-invalid={invalid(v)}
                      onChange={e => setCell(i, j, e.target.value)}
                      onPaste={e => onPaste(e, i, j)}
                      onKeyDown={e => {
                        const move = (di: number, dj: number) => { e.preventDefault(); (document.getElementById(`${uid}-${i + di}-${j + dj}`) as HTMLInputElement | null)?.focus(); };
                        if (e.key === 'ArrowDown' || e.key === 'Enter') move(1, 0);
                        else if (e.key === 'ArrowUp') move(-1, 0);
                      }}
                    />
                  </td>
                ))}
                {p.rowExtra && <td className="!p-0.5"><input className="input num" aria-label={`${p.rowExtra.label} of ${rl(i)}`} value={p.rowExtra.values[i] ?? ''} aria-invalid={invalid(p.rowExtra.values[i] ?? '')} onChange={e => p.rowExtra!.onChange(p.rowExtra!.values.map((x, k) => (k === i ? e.target.value : x)))} /></td>}
              </tr>
            ))}
            {p.colExtra && (
              <tr>
                <th scope="row">{p.colExtra.label}</th>
                {p.colExtra.values.map((v, j) => <td key={j} className="!p-0.5"><input className="input num" aria-label={`${p.colExtra!.label} of ${cl(j)}`} value={v} aria-invalid={invalid(v)} onChange={e => p.colExtra!.onChange(p.colExtra!.values.map((x, k) => (k === j ? e.target.value : x)))} /></td>)}
                {p.rowExtra && <td />}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {p.resizable !== false && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="muted mr-1">{p.square ? 'Size' : 'Rows'}</span>
          <Btn size="icon" aria-label="Remove a row" disabled={rows <= (p.minRows ?? 1)} onClick={() => { delRow(); if (p.square) delCol(); }}><Minus size={12} /></Btn>
          <span className="mono w-4 text-center">{rows}</span>
          <Btn size="icon" aria-label="Add a row" disabled={rows >= (p.maxRows ?? 15)} onClick={() => { addRow(); if (p.square) addCol(); }}><Plus size={12} /></Btn>
          {!p.square && <>
            <span className="muted ml-2 mr-1">Columns</span>
            <Btn size="icon" aria-label="Remove a column" disabled={cols <= (p.minCols ?? 1)} onClick={delCol}><Minus size={12} /></Btn>
            <span className="mono w-4 text-center">{cols}</span>
            <Btn size="icon" aria-label="Add a column" disabled={cols >= (p.maxCols ?? 15)} onClick={addCol}><Plus size={12} /></Btn>
          </>}
          <label className="btn btn-sm ml-auto cursor-pointer"><Upload size={12} /> Import CSV<input type="file" accept=".csv,.txt,.tsv" className="sr-only" onChange={e => { void onFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        </div>
      )}
      <p className="text-[13px] muted">Fractions (3/4) and decimals (0.75) are accepted. You can paste a block from a spreadsheet{p.allowBlocked ? '; type M or x for a prohibited route' : ''}.</p>
    </div>
  );
}
