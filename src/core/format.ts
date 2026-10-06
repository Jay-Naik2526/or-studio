/**
 * Small, pure formatting helpers shared by solvers and UI. No DOM, no React.
 */

const SUB_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
const SUB_MAP: Record<string, string> = Object.fromEntries(
  SUB_DIGITS.split('').map((ch, i) => [ch, String(i)])
);

/** 12 → "₁₂". */
export function subscript(n: number | string): string {
  return String(n)
    .split('')
    .map(ch => (ch >= '0' && ch <= '9' ? SUB_DIGITS[Number(ch)]! : ch))
    .join('');
}

/** "x₁₂" → "x12". Leaves everything else untouched. */
export function unsubscript(s: string): string {
  return s
    .split('')
    .map(ch => SUB_MAP[ch] ?? ch)
    .join('');
}

/** Canonical display name for user-typed variables: "x1" → "x₁", "y12" → "y₁₂", "prod_A" stays. */
export function canonVarName(name: string): string {
  const plain = unsubscript(name);
  const m = plain.match(/^([A-Za-z])(\d+)$/);
  if (m) return `${m[1]}${subscript(m[2]!)}`;
  return plain;
}

/** Name for a generated column: s₃, e₂, a₁. */
export function genName(prefix: string, index: number): string {
  return `${prefix}${subscript(index)}`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]!);
}

/** Join with Oxford-comma style: "a, b and c". */
export function joinList(items: string[], conj = 'and'): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${conj} ${items[items.length - 1]}`;
}

/** Format a float for display without trailing noise. */
export function fmt(x: number, digits = 4): string {
  if (!Number.isFinite(x)) return x > 0 ? '∞' : x < 0 ? '−∞' : 'NaN';
  const r = Number(x.toFixed(digits));
  return Object.is(r, -0) ? '0' : String(r);
}
