import { useEffect, useState, useCallback } from 'react';

export interface Route { path: string[]; query: URLSearchParams; raw: string }

function parse(): Route {
  const h = window.location.hash.replace(/^#/, '') || '/';
  const [p, q = ''] = h.split('?');
  return { path: p!.split('/').filter(Boolean), query: new URLSearchParams(q), raw: h };
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export function href(path: string, query?: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  Object.entries(query ?? {}).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
  const s = q.toString();
  return `#${path.startsWith('/') ? path : '/' + path}${s ? '?' + s : ''}`;
}

export function navigate(path: string, query?: Record<string, string | undefined>, replace = false): void {
  const h = href(path, query);
  if (replace) window.history.replaceState(null, '', h);
  else window.location.hash = h.slice(1);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Update only the query string of the current route without adding history entries. */
export function setQuery(patch: Record<string, string | undefined>): void {
  const r = parse();
  const q = new URLSearchParams(r.query);
  Object.entries(patch).forEach(([k, v]) => { if (v === undefined || v === '') q.delete(k); else q.set(k, v); });
  const s = q.toString();
  window.history.replaceState(null, '', `#/${r.path.join('/')}${s ? '?' + s : ''}`);
}

export function useQueryParam(name: string): [string | null, (v: string | undefined) => void] {
  const route = useRoute();
  const set = useCallback((v: string | undefined) => setQuery({ [name]: v }), [name]);
  return [route.query.get(name), set];
}
