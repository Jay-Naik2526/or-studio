import { useId } from 'react';
import { GanttData } from '../../core/solvers/sequencing/sequencing';

const PALETTE = ['--entering', '--ok', '--leaving', '--bad', '--warn', '--focus'];

/** a "nice" tick step (1, 2, 5 × 10ⁿ) giving about `target` ticks over `span` */
export function niceStep(span: number, target = 10): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

const fmt = (x: number) => String(Math.round(x * 100) / 100);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

interface Props { data: GanttData; jobs: string[]; machines: string[]; sequence: number[] }

/** Gantt chart of a flow-shop schedule: one row per machine, bars coloured and labelled by job, hatched idle gaps, time axis. */
export function GanttSequence({ data, jobs, machines, sequence }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const n = sequence.length, m = data.rows.length;
  const T = Math.max(data.makespan.toNumber(), 1e-9);
  const W = Math.max(640, Math.min(2600, 130 + n * 34)), L = 96, R = 16, top = 30, rowH = 42, barH = 28;
  const H = top + m * rowH + 14;
  const X = (t: number) => L + (t / T) * (W - L - R);
  const step = niceStep(T, W > 900 ? 16 : 10);
  const ticks: number[] = [];
  for (let t = 0; t <= T + step * 1e-9 && ticks.length < 80; t += step) ticks.push(Math.round(t / step) * step);
  if (ticks[ticks.length - 1]! < T - step * 0.45) ticks.push(T);
  const colour = (job: number) => PALETTE[job % PALETTE.length]!;
  const jobPos = new Map(sequence.map((j, p) => [j, p]));
  const summary = `Gantt chart, ${n} job${n === 1 ? '' : 's'} on ${m} machines, total elapsed time ${fmt(T)}.`;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} style={{ width: '100%', minWidth: Math.min(W, 560), height: 'auto', display: 'block' }}>
        <defs>
          <pattern id={`hatch${uid}`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="var(--border-strong)" strokeWidth="1.6" />
          </pattern>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={X(t)} x2={X(t)} y1={top - 4} y2={H - 10} stroke="var(--border)" strokeWidth="1" />
            <text x={X(t)} y={top - 10} fontSize="11" textAnchor="middle" fill="var(--text-3)" className="mono">{fmt(t)}</text>
          </g>
        ))}
        {data.rows.map((row, k) => {
          const y = top + k * rowH + (rowH - barH) / 2;
          return (
            <g key={k}>
              <line x1={L} x2={W - R} y1={top + (k + 1) * rowH - 0.5} y2={top + (k + 1) * rowH - 0.5} stroke="var(--border)" />
              <text x={8} y={y + barH / 2 + 4} fontSize="12" fontWeight="700" fill="var(--text)">{short(machines[k] ?? `M${k + 1}`, 11)}</text>
              {row.idle.map((g, i) => {
                const w = X(g.end.toNumber()) - X(g.start.toNumber());
                return (
                  <g key={`i${i}`}>
                    <title>{`${machines[k]} idle ${g.start.toString()} – ${g.end.toString()} (${g.kind === 'initial' ? 'waiting for the first job' : g.kind === 'gap' ? 'waiting between jobs' : 'finished early'})`}</title>
                    <rect x={X(g.start.toNumber())} y={y} width={Math.max(0.5, w)} height={barH} fill={`url(#hatch${uid})`} stroke="var(--border-strong)" strokeDasharray="3 2" strokeWidth="0.8" />
                  </g>
                );
              })}
              {row.bars.map((b, i) => {
                const x0 = X(b.start.toNumber()), x1 = X(b.end.toNumber()), w = x1 - x0;
                const name = jobs[b.job] ?? '?';
                const c = colour(jobPos.get(b.job) ?? b.job);
                const label = w >= 9 + name.length * 7 ? name : w >= 14 ? short(name, Math.max(1, Math.floor((w - 4) / 7))) : '';
                return (
                  <g key={`b${i}`}>
                    <title>{`${name} on ${machines[k]}: ${b.start.toString()} → ${b.end.toString()} (duration ${b.end.sub(b.start).toString()})`}</title>
                    <rect x={x0} y={y} width={Math.max(1.5, w)} height={barH} style={{ fill: `color-mix(in srgb, var(${c}) 32%, var(--surface))`, stroke: `var(${c})` }} strokeWidth="1.5" />
                    {label && <text x={x0 + w / 2} y={y + barH / 2 + 4} fontSize="12" fontWeight="700" textAnchor="middle" fill="var(--text)">{label}</text>}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Legend: sequence order with the job colours (also useful when bars are too narrow to carry a label). */
export function GanttLegend({ jobs, sequence }: { jobs: string[]; sequence: number[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[0.82rem] mono" aria-label="Job order and colours">
      {sequence.slice(0, 60).map((j, p) => (
        <li key={j} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" style={{ width: 12, height: 12, display: 'inline-block', background: `color-mix(in srgb, var(${PALETTE[p % PALETTE.length]}) 32%, var(--surface))`, border: `1.5px solid var(${PALETTE[p % PALETTE.length]})` }} />
          {jobs[j]}
        </li>
      ))}
      {sequence.length > 60 && <li className="muted">+{sequence.length - 60} more</li>}
      <li className="inline-flex items-center gap-1.5 muted">
        <span aria-hidden="true" style={{ width: 12, height: 12, display: 'inline-block', border: '1px dashed var(--border-strong)', background: 'repeating-linear-gradient(45deg, var(--border-strong) 0 1px, transparent 1px 4px)' }} /> idle
      </li>
    </ul>
  );
}
