import { useState } from 'react';
import { GraduationCap, CheckCircle2, XCircle, Lightbulb, ArrowRight, Eye } from 'lucide-react';
import { Btn, Card, Badge } from '../ui/ui';

export interface TutorOption { id: string; label: string; correct: boolean; feedback: string; misconception?: string }

export interface TutorQuestion {
  id: string;
  prompt: string;
  hint?: string;
  options: TutorOption[];
  /** shown after the student gives up / answers correctly */
  reveal?: string;
}

export interface TutorStats { asked: number; firstTry: number; attempts: number }

interface Props {
  question: TutorQuestion | null;
  stats: TutorStats;
  onResult: (correctFirstTry: boolean, attempts: number) => void;
  onAdvance: () => void;
  finishedText?: string;
}

export function TutorPanel({ question, stats, onResult, onAdvance, finishedText }: Props) {
  const [pickedRaw, setPicked] = useState<string[]>([]);
  const [revealedRaw, setRevealed] = useState(false);
  const key = question?.id;
  const [lastKey, setLastKey] = useState(key);
  // the question changed: reset state, and ignore the stale state for the rest of this render
  const stale = key !== lastKey;
  if (stale) { setLastKey(key); setPicked([]); setRevealed(false); }
  const picked = stale ? [] : pickedRaw;
  const revealed = stale ? false : revealedRaw;

  if (!question) {
    return (
      <Card title="Tutor mode" icon={<GraduationCap size={14} />} right={<Badge kind="accent">{stats.firstTry}/{stats.asked} first try</Badge>}>
        <p className="text-sm">{finishedText ?? 'You reached the end of the solution.'}</p>
        <p className="text-[0.82rem] muted mt-2">Switch to Auto mode to review every step, or edit the model to try another problem.</p>
      </Card>
    );
  }
  const correctPick = picked.find(id => question.options.find(o => o.id === id)?.correct);
  const correctOpt = question.options.find(o => o.id === correctPick);
  const wrong = picked.filter(id => !question.options.find(o => o.id === id)?.correct);
  const done = !!correctPick || revealed;
  const choose = (o: TutorOption) => {
    if (done || picked.includes(o.id)) return;
    const next = [...picked, o.id];
    setPicked(next);
    if (o.correct) onResult(next.length === 1, next.length);
  };
  return (
    <Card title="Tutor mode" icon={<GraduationCap size={14} />} right={<Badge kind="accent">{stats.firstTry}/{stats.asked} first try</Badge>}>
      <div className="flex flex-col gap-3">
        <p className="font-semibold text-sm">{question.prompt}</p>
        {question.hint && <p className="text-[0.82rem] muted inline-flex gap-1 items-start"><Lightbulb size={13} className="shrink-0 mt-0.5" /> {question.hint}</p>}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Answer choices">
          {question.options.map(o => {
            const was = picked.includes(o.id);
            const style = was ? (o.correct ? { background: 'var(--ok-soft)', borderColor: 'var(--ok)', color: 'var(--ok)' } : { background: 'var(--bad-soft)', borderColor: 'var(--bad)', color: 'var(--bad)' }) : revealed && o.correct ? { background: 'var(--ok-soft)', borderColor: 'var(--ok)' } : undefined;
            return (
              <button key={o.id} type="button" className="btn mono" style={style} disabled={done && !was && !(revealed && o.correct)} onClick={() => choose(o)} aria-pressed={was}>
                {was && (o.correct ? <CheckCircle2 size={14} aria-label="correct" /> : <XCircle size={14} aria-label="wrong" />)}
                {o.label}
              </button>
            );
          })}
        </div>
        {wrong.map(id => {
          const o = question.options.find(x => x.id === id);
          if (!o) return null;
          return (
            <div key={id} className="callout callout-bad" role="alert">
              <XCircle size={15} className="shrink-0 mt-0.5" />
              <div><div>{o.feedback}</div>{o.misconception && <div className="text-[0.82rem] mt-1 opacity-90"><b>Misconception:</b> {o.misconception}</div>}</div>
            </div>
          );
        })}
        {correctOpt && (
          <div className="callout callout-ok" role="status">
            <CheckCircle2 size={15} className="shrink-0 mt-0.5" />
            <div>{correctOpt?.feedback}{wrong.length > 0 && <span className="muted"> (after {wrong.length} wrong {wrong.length === 1 ? 'try' : 'tries'})</span>}</div>
          </div>
        )}
        {revealed && question.reveal && <div className="callout callout-info"><Eye size={15} className="shrink-0 mt-0.5" /><div>{question.reveal}</div></div>}
        <div className="flex gap-2">
          {!done && wrong.length >= 2 && <Btn onClick={() => { setRevealed(true); onResult(false, picked.length + 1); }}><Eye size={14} /> Show the answer</Btn>}
          {done && <Btn variant="primary" onClick={onAdvance}>Continue <ArrowRight size={14} /></Btn>}
        </div>
      </div>
    </Card>
  );
}

export function useTutorStats() {
  const [s, set] = useState<TutorStats>({ asked: 0, firstTry: 0, attempts: 0 });
  return {
    stats: s,
    record: (first: boolean, attempts: number) => set(v => ({ asked: v.asked + 1, firstTry: v.firstTry + (first ? 1 : 0), attempts: v.attempts + attempts })),
    reset: () => set({ asked: 0, firstTry: 0, attempts: 0 }),
  };
}
