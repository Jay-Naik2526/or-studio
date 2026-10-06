import { Rational } from '../core/math/rational';

export type NumParse = { ok: true; value: Rational } | { ok: false; error: string };

/** Accepts integers, decimals, fractions ("3/4", "-1.5/2"), unicode minus; empty ⇒ error. */
export function parseNum(s: string): NumParse {
  const t = s.trim().replace(/−/g, '-').replace(/,/g, '.').replace(/\s+/g, '');
  if (t === '') return { ok: false, error: 'empty' };
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(\/[+-]?(\d+(\.\d*)?|\.\d+))?$/.test(t)) return { ok: false, error: `"${s}" is not a number` };
  try {
    const v = Rational.parse(t.startsWith('+') ? t.slice(1) : t);
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e instanceof Error && /zero/i.test(e.message) ? 'division by zero' : `"${s}" is not a number` };
  }
}

export function num(s: string, fallback = Rational.ZERO): Rational {
  const r = parseNum(s);
  return r.ok ? r.value : fallback;
}

export function plainNum(s: string): number | null {
  const r = parseNum(s);
  return r.ok ? Number(r.value.toDecimal(10)) : null;
}
