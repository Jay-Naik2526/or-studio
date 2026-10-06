import { ReactNode, ButtonHTMLAttributes, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle, ChevronDown, ChevronRight, Lightbulb } from 'lucide-react';
import { Diagnostic } from '../../core/types/solver';

export function Card({ title, icon, right, children, className = '', bodyClass = 'card-b', id }: { title?: ReactNode; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; id?: string }) {
  return (
    <section className={`card ${className}`} id={id}>
      {(title || right) && (
        <header className="card-h">
          <span className="inline-flex items-center gap-2">{icon}{title}</span>
          {right && <span className="inline-flex items-center gap-2">{right}</span>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Btn({ variant = 'default', size, className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost'; size?: 'sm' | 'icon' }) {
  return <button type="button" {...p} className={`btn ${variant === 'primary' ? 'btn-primary' : variant === 'ghost' ? 'btn-ghost' : ''} ${size === 'sm' ? 'btn-sm' : size === 'icon' ? 'btn-icon' : ''} ${className}`} />;
}

export function Badge({ kind = 'default', children, title }: { kind?: 'default' | 'ok' | 'bad' | 'warn' | 'info' | 'accent'; children: ReactNode; title?: string }) {
  return <span title={title} className={`badge ${kind === 'default' ? '' : `badge-${kind}`}`}>{children}</span>;
}

export function Callout({ kind = 'info', children, title }: { kind?: 'ok' | 'bad' | 'warn' | 'info'; children: ReactNode; title?: string }) {
  const Icon = kind === 'ok' ? CheckCircle2 : kind === 'bad' ? XCircle : kind === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`callout callout-${kind}`} role={kind === 'bad' ? 'alert' : undefined}>
      <Icon size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div>{title && <div className="font-semibold">{title}</div>}{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full overflow-x-auto" style={{ border: '1px solid var(--accent-edge)', background: 'var(--surface)' }}>
      {options.map((o, i) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title} onClick={() => onChange(o.value)}
          className="px-3 py-1.5 text-[0.84rem] font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors hover:bg-[var(--surface-3)]"
          style={{ borderLeft: i ? '1px solid var(--border-strong)' : 'none', ...(value === o.value ? { background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 700 } : { color: 'var(--text-2)' }) }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, className = '' }: { label: ReactNode; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-[0.82rem] font-semibold" style={{ color: 'var(--text-2)' }}>{label}</label>
      {children(id)}
      {hint && <span className="text-[13px] muted">{hint}</span>}
    </div>
  );
}

export function Collapsible({ title, children, defaultOpen = false, right }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="card-h w-full cursor-pointer text-left" style={{ borderBottom: open ? undefined : 'none' }}>
        <span className="inline-flex items-center gap-2">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{title}</span>
        {right}
      </button>
      {open && <div className="card-b">{children}</div>}
    </div>
  );
}

export function DiagnosticsList({ items, title = 'Diagnostics' }: { items: Diagnostic[]; title?: string }) {
  if (!items.length) return null;
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...items].sort((a, b) => rank[a.severity] - rank[b.severity]);
  return (
    <Card title={title} icon={<Lightbulb size={14} />} right={<Badge>{items.length}</Badge>}>
      <ul className="flex flex-col gap-1.5" aria-label={title}>
        {sorted.map((d, i) => (
          <li key={i}>
            <div className={`callout callout-${d.severity === 'error' ? 'bad' : d.severity === 'warning' ? 'warn' : 'info'}`}>
              {d.severity === 'error' ? <XCircle size={15} className="shrink-0 mt-0.5" aria-label="error" /> : d.severity === 'warning' ? <AlertTriangle size={15} className="shrink-0 mt-0.5" aria-label="warning" /> : <Info size={15} className="shrink-0 mt-0.5" aria-label="note" />}
              <div>
                <span className="mono text-[12px] font-bold mr-2 opacity-70">{d.code}</span>
                {d.message}
                {d.detail && <div className="text-[13px] mt-1 opacity-80 mono">{d.detail}</div>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export type StatusKind = 'ok' | 'bad' | 'warn' | 'info';
export function StatusBanner({ kind, label, children }: { kind: StatusKind; label: string; children?: ReactNode }) {
  const Icon = kind === 'ok' ? CheckCircle2 : kind === 'bad' ? XCircle : kind === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`callout callout-${kind} items-center`} role="status" style={{ padding: '.6rem .9rem' }}>
      <Icon size={20} className="shrink-0" aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 w-full">
        <span className="font-bold uppercase tracking-wide text-xs">{label}</span>
        {children}
      </div>
    </div>
  );
}

export function statusKind(status: string): StatusKind {
  if (status === 'optimal' || status === 'optimal-alternate-exists') return 'ok';
  if (status === 'infeasible' || status === 'unbounded' || status === 'invalid-input' || status === 'unbounded-objective' || status === 'numerical-failure') return 'bad';
  return 'warn';
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'optimal': return 'Optimal';
    case 'optimal-alternate-exists': return 'Optimal · alternate optima exist';
    case 'infeasible': return 'Infeasible';
    case 'unbounded': return 'Unbounded';
    case 'iteration-limit': return 'Stopped — limit reached (not proven optimal)';
    case 'invalid-input': return 'Input problem';
    default: return status;
  }
}

export function ResultStat({ label, children, big }: { label: string; children: ReactNode; big?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="eyebrow">{label}</span>
      <span className={`mono font-bold ${big ? 'text-lg' : 'text-sm'}`}>{children}</span>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="muted text-sm py-6 text-center">{children}</div>;
}
