/** Small pure helpers for the hash router and the colour tokens; no DOM access so they can be unit-tested in node. */

/** decodeURIComponent that never throws on malformed escapes such as "%zz" — the raw text is returned instead. */
export function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export type Resolved =
  | { kind: 'hub' }
  | { kind: 'library' | 'about' | 'docs' }
  | { kind: 'module'; id: string }
  | { kind: 'unknown-module'; id: string }
  | { kind: 'not-found'; id: string };

/** Map the path segments of the hash route to a screen. Ids are decoded and matched case-insensitively. */
export function resolveRoute(path: string[], moduleIds: readonly string[]): Resolved {
  const first = path[0];
  if (first === undefined) return { kind: 'hub' };
  const head = safeDecode(first).toLowerCase();
  if (head === 'library' || head === 'about' || head === 'docs') return { kind: head };
  if (head === 'm') {
    const raw = path[1] === undefined ? '' : safeDecode(path[1]);
    const id = raw.toLowerCase();
    if (id && moduleIds.includes(id)) return { kind: 'module', id };
    return { kind: 'unknown-module', id: raw.slice(0, 40) };
  }
  return { kind: 'not-found', id: safeDecode(first).slice(0, 40) };
}

/** Short stable hash (FNV-1a, 32 bit) of a string — used to tell two shared-model links apart without keeping them. */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + '.' + s.length.toString(36);
}

/**
 * React key for a module screen. A different library problem, variant or shared model must remount the module so
 * that no state from the previous one survives. The whole shared-model string is hashed: the first characters of two
 * different compressed models are usually identical.
 */
export function moduleKey(id: string, q: { get(name: string): string | null }): string {
  const model = q.get('model');
  return `${id}|${q.get('lib') ?? ''}|${q.get('variant') ?? ''}|${model ? hash32(model) : ''}`;
}

/* ---- WCAG 2.x contrast ---- */
export function parseHex(h: string): [number, number, number] {
  let s = h.trim().replace(/^#/, '');
  if (s.length === 3) s = [...s].map(c => c + c).join('');
  const n = parseInt(s, 16);
  if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error(`Bad hex colour: ${h}`);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function relLuminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrastRatio(a: string, b: string): number {
  const x = relLuminance(parseHex(a)), y = relLuminance(parseHex(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
