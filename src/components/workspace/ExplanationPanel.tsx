import { BookOpen, ChevronDown, ChevronRight, StickyNote } from 'lucide-react';
import { createContext, useContext, useState } from 'react';

export const CompactCtx = createContext(false);
import { Explanation } from '../../core/types/step';
import { Katex } from '../ui/Katex';
import { Badge } from '../ui/ui';

export function ExplanationPanel({ explanation, phase }: { explanation: Explanation; phase?: string }) {
  const compact = useContext(CompactCtx);
  const [open, setOpen] = useState(!compact);
  return (
    <section className="card" aria-label="Step explanation">
      <header className="card-h">
        <span className="inline-flex items-center gap-2"><BookOpen size={14} /> Explanation</span>
        {phase && <Badge kind="accent">{phase}</Badge>}
      </header>
      <div className="card-b flex flex-col gap-3">
        <p className="font-semibold text-[1.05rem] leading-snug">{explanation.short}</p>
        <button type="button" className="text-[0.82rem] inline-flex items-center gap-1 muted cursor-pointer self-start" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Full reasoning
        </button>
        {open && <p className="text-[0.98rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>{explanation.detailed}</p>}
        {explanation.formula && <div className="overflow-x-auto rounded-md p-2" style={{ background: 'var(--surface-2)' }}><Katex tex={explanation.formula} display /></div>}
        {explanation.rule && <div className="text-[0.82rem]"><span className="eyebrow mr-2">Rule applied</span><span className="font-semibold">{explanation.rule}</span></div>}
        {explanation.note && <div className="callout callout-warn"><StickyNote size={15} className="shrink-0 mt-0.5" /><span>{explanation.note}</span></div>}
      </div>
    </section>
  );
}
