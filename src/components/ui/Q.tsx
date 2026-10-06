import { Rational } from '../../core/math/rational';
import { MNum } from '../../core/math/bigm';

/** Stacked fraction rendering for exact rationals; integers render plainly. */
export function Q({ v, dec }: { v: Rational | null | undefined; dec?: boolean }) {
  if (v === null || v === undefined) return <span aria-label="infinity">∞</span>;
  if (v.d === 1n) return <span>{v.n < 0n ? '−' : ''}{(v.n < 0n ? -v.n : v.n).toString()}</span>;
  const neg = v.n < 0n;
  const n = (neg ? -v.n : v.n).toString();
  return (
    <span title={v.toDecimal(4)} aria-label={`${neg ? 'minus ' : ''}${n} over ${v.d}`}>
      {neg && <span className="sgn">−</span>}
      <span className="frac" aria-hidden="true"><span className="n">{n}</span><span className="d">{v.d.toString()}</span></span>
      {dec && <span className="muted" style={{ fontSize: '.75em' }}> ≈{v.toDecimal(3)}</span>}
    </span>
  );
}

/** a + bM numbers */
export function QM({ v }: { v: MNum | null | undefined }) {
  if (!v) return <span>∞</span>;
  if (!v.hasM()) return <Q v={v.a} />;
  const b = v.b;
  const mPart = b.eq(Rational.ONE) ? <span>M</span> : b.eq(Rational.MINUS_ONE) ? <span>−M</span> : <span><Q v={b} />M</span>;
  if (v.a.isZero()) return mPart;
  return <span>{mPart}<span> {v.a.isNegative() ? '−' : '+'} </span><Q v={v.a.abs()} /></span>;
}

export const qs = (v: Rational | null | undefined): string => (v ? v.toString() : '∞');
export const qms = (v: MNum | null | undefined): string => (v ? v.toString() : '∞');
