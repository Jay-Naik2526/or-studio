import { Card } from '../ui/ui';

export function DocsPage() {
  const S = ({ t, children }: { t: string; children: React.ReactNode }) => <Card title={t} className="min-w-0"><div className="text-sm flex flex-col gap-2 leading-relaxed" style={{ color: 'var(--text-2)' }}>{children}</div></Card>;
  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <h1 className="display text-3xl font-semibold">User manual</h1>
      <S t="1 · The workspace">
        <p>Every module has the same layout, read top to bottom like a worked sheet: <b>01 Model</b> (the input, which can be hidden), then <b>02 Solution</b> — the result, the written <b>explanation</b> of the current step and the <b>visualisation</b>, with view tabs. The step player docked at the bottom runs a solution forwards and backwards; the toolbar in the title block exports, saves, opens and shares.</p>
        <p><b>Auto / Tutor</b> toggle in the header switches instantly. In Tutor mode the next decision is hidden and you choose it; wrong answers explain the specific misconception.</p>
      </S>
      <S t="2 · Entering a linear programme">
        <pre className="mono text-[0.82rem] p-3 rounded-md overflow-x-auto max-w-full" style={{ background: 'var(--surface-2)' }} tabIndex={0} aria-label="Example model text">{`max 3x1 + 5x2
subject to
  labour: x1 + 2x2 <= 10
  3x1 + 2x2 >= 6
  x1 - x2 = 1
  free x3         (unrestricted variable)
  int x1          (integer),  bin x2  (0/1)`}</pre>
        <p>Variables on both sides, constants on the left, <code>2 &lt;= x + y &lt;= 8</code>, fractions like <code>1/2x</code>, unicode (≤ ≥ x₁) are all accepted. Errors report line and column. The <b>Form</b> tab edits the same model with a grid.</p>
      </S>
      <S t="3 · Methods">
        <p><b>Auto</b> picks plain simplex when every row is ≤ with a non-negative right-hand side and Two-Phase otherwise; choosing a method that cannot start the problem redirects with an explanation. <b>Dual simplex</b> needs a dual-feasible start (minimisation with c ≥ 0).</p>
        <p>Degeneracy, ties, cycling (detected by hashing bases and answered with Bland’s rule), alternate optima, unbounded rays, infeasibility certificates and redundant constraints are all reported in the diagnostics panel.</p>
      </S>
      <S t="4 · Diff mode">
        <p>Do the problem by hand, then enter your tableau / allocation grid for any iteration. OR-Studio finds the <b>first divergence</b>, lists the cells, and guesses the cause: wrong entering or leaving variable, an un-normalised pivot row, a wrong elimination multiplier, sign inversion, or a single arithmetic slip.</p>
      </S>
      <S t="5 · Export, save and share">
        <p><b>PDF</b> opens a clean printable report with every step and explanation — choose “Save as PDF”. <b>LaTeX</b> produces an <code>amsmath/booktabs</code> document. <b>PNG</b> captures the current view. <b>JSON</b> holds the model. <b>Share link</b> encodes the model in the URL. Work is autosaved in your browser; if storage is full a file is downloaded instead.</p>
      </S>
      <S t="6 · Accessibility">
        <p>Every control is keyboard reachable; step changes are announced to screen readers; tables have headers and captions; colours are always paired with icons or text; animations respect <i>reduce motion</i>.</p>
      </S>
    </div>
  );
}
