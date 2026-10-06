import { useEffect, useRef, useState, useCallback } from 'react';
import { SkipBack, ChevronLeft, ChevronRight, SkipForward, Play, Pause } from 'lucide-react';
import { announce } from '../../lib/announce';
import { Btn } from '../ui/ui';
import { modalOpen, ownsArrowKeys, ownsSpaceKey, shortcutBlocked } from '../ui/keys';

interface Props {
  count: number;
  index: number;
  onChange: (i: number) => void;
  labels?: string[];
  /** disable global key handling when a modal/tutor needs the keys */
  keyboard?: boolean;
  summary?: string;
}

export function StepPlayer({ count, index, onChange, labels, keyboard = true, summary }: Props) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const last = count - 1;
  const idx = Math.min(index, Math.max(0, last));
  const ref = useRef({ idx, last, onChange });
  ref.current = { idx, last, onChange };

  const go = useCallback((i: number) => ref.current.onChange(Math.max(0, Math.min(ref.current.last, i))), []);

  useEffect(() => {
    if (!playing) return;
    if (idx >= last) { setPlaying(false); return; }
    const t = window.setTimeout(() => go(idx + 1), 1100 / speed);
    return () => window.clearTimeout(t);
  }, [playing, idx, last, speed, go]);

  // announce a change of the message itself — callers usually pass a fresh `labels` array on every render
  const label = labels?.[idx];
  const message = count > 0 ? `Step ${idx + 1} of ${count}${label ? ': ' + label : ''}${summary ? '. ' + summary : ''}` : '';
  useEffect(() => { if (message) announce(message); }, [message]);

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (typeof e.key !== 'string' || shortcutBlocked(e, modalOpen())) return;
      const t = e.target;
      const { idx: i, last: l } = ref.current;
      const arrows = !ownsArrowKeys(t);
      if (e.key === 'ArrowRight' && arrows) { e.preventDefault(); go(i + 1); }
      else if (e.key === 'ArrowLeft' && arrows) { e.preventDefault(); go(i - 1); }
      else if (e.key === 'Home' && arrows) { e.preventDefault(); go(0); }
      else if (e.key === 'End' && arrows) { e.preventDefault(); go(l); }
      else if (e.key === ' ' && !ownsSpaceKey(t)) { e.preventDefault(); setPlaying(p => !p); }
      else if (/^[1-9]$/.test(e.key) && !e.shiftKey) { go(Number(e.key) - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboard, go]);

  if (count === 0) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2" role="group" aria-label="Step player">
      <div className="flex items-center gap-1">
        <Btn size="icon" className="hidden sm:inline-flex" onClick={() => go(0)} disabled={idx === 0} aria-label="First step" title="First (Home)"><SkipBack size={15} /></Btn>
        <Btn size="icon" onClick={() => go(idx - 1)} disabled={idx === 0} aria-label="Previous step" title="Previous (←)"><ChevronLeft size={15} /></Btn>
        <Btn variant="primary" onClick={() => (idx >= last ? (go(0), setPlaying(true)) : setPlaying(p => !p))} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)" style={{ minWidth: 88 }}>
          {playing ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Play</>}
        </Btn>
        <Btn size="icon" onClick={() => go(idx + 1)} disabled={idx >= last} aria-label="Next step" title="Next (→)"><ChevronRight size={15} /></Btn>
        <Btn size="icon" className="hidden sm:inline-flex" onClick={() => go(last)} disabled={idx >= last} aria-label="Last step" title="Last (End)"><SkipForward size={15} /></Btn>
      </div>
      <div className="flex items-center gap-3 flex-1 min-w-[150px] sm:min-w-[220px]">
        <span className="mono whitespace-nowrap leading-none" aria-hidden="true"><b className="text-[1.35rem]">{pad(idx + 1)}</b><span className="muted text-[0.9rem]"> / {pad(count)}</span></span>
        <div className="relative flex-1 min-w-0">
          {count <= 60 && count > 1 && (
            <div className="absolute inset-x-[7px] top-1/2 -translate-y-1/2 flex justify-between pointer-events-none" aria-hidden="true">
              {Array.from({ length: count }, (_, i) => <span key={i} style={{ width: 1, height: i <= idx ? 10 : 6, background: i <= idx ? 'var(--text)' : 'var(--border-strong)' }} />)}
            </div>
          )}
          <input className="range relative" type="range" min={0} max={last} value={idx} onChange={e => go(Number(e.target.value))} aria-label="Step" aria-valuetext={`Step ${idx + 1} of ${count}`} />
        </div>
      </div>
      <div className="hidden sm:flex items-center gap-1 hide-in-presentation" role="group" aria-label="Playback speed">
        {[0.5, 1, 2, 4].map(s => (
          <Btn key={s} size="sm" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</Btn>
        ))}
      </div>
    </div>
  );
}
