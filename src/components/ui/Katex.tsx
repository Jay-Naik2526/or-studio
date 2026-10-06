import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export function Katex({ tex, display = false }: { tex: string; display?: boolean }) {
  const html = useMemo(() => {
    try { return katex.renderToString(String(tex).slice(0, 4000), { throwOnError: false, displayMode: display, output: 'htmlAndMathml', trust: false, maxExpand: 200, maxSize: 50 }); }
    catch { return null; }
  }, [tex, display]);
  if (html === null) return <code className="mono">{tex}</code>;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
