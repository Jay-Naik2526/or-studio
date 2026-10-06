import { Rational } from '../../core/math/rational';

interface Props { label: string; current: Rational; min: Rational | null; max: Rational | null; unit?: string; value?: number; ariaLabel?: string }

/** Visual ranging bar: allowable interval with the current value marked; infinite ends are open-ended arrows. */
export function RangeBar({ label, current, min, max, value }: Props) {
  const cur = Number(current.toDecimal(6));
  const lo = min ? Number(min.toDecimal(6)) : null;
  const hi = max ? Number(max.toDecimal(6)) : null;
  const span = Math.max(1, Math.abs(cur), Math.abs((lo ?? cur)), Math.abs((hi ?? cur)));
  const L = lo ?? cur - span * 0.8;
  const H = hi ?? cur + span * 0.8;
  const pad = (H - L) * 0.12 || 1;
  const a = L - pad, b = H + pad;
  const x = (v: number) => ((v - a) / (b - a)) * 100;
  const v = value !== undefined ? x(Math.max(a, Math.min(b, value))) : null;
  return (
    <div role="img" aria-label={`${label}: current ${current.toString()}, allowable from ${min ? min.toString() : 'minus infinity'} to ${max ? max.toString() : 'plus infinity'}`}>
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" className="w-full h-7" aria-hidden="true">
        <rect x="0" y="5" width="100" height="4" rx="2" fill="var(--surface-2)" stroke="var(--border)" strokeWidth=".3" />
        <rect x={x(L)} y="4" width={Math.max(0.5, x(H) - x(L))} height="6" rx="2" fill="var(--ok-soft)" stroke="var(--ok)" strokeWidth=".4" />
        {lo === null && <path d={`M ${x(L) + 1} 7 l 3 -2.4 v 4.8 z`} fill="var(--ok)" />}
        {hi === null && <path d={`M ${x(H) - 1} 7 l -3 -2.4 v 4.8 z`} fill="var(--ok)" />}
        <line x1={x(cur)} x2={x(cur)} y1="1" y2="13" stroke="var(--series)" strokeWidth="1" />
        {v !== null && <circle cx={v} cy="7" r="2.2" fill="var(--leaving)" stroke="var(--surface)" strokeWidth=".5" />}
      </svg>
      <div className="flex justify-between mono text-[12px] muted -mt-1"><span>{min ? min.toString() : '−∞'}</span><span style={{ color: 'var(--accent-text)' }}>{current.toString()}</span><span>{max ? max.toString() : '+∞'}</span></div>
    </div>
  );
}
