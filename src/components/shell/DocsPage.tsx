import { Card } from '../ui/ui';
import { href } from '../../lib/router';

export function DocsPage() {
  const S = ({ t, children }: { t: string; children: React.ReactNode }) => <Card title={t} className="min-w-0"><div className="text-sm flex flex-col gap-2 leading-relaxed" style={{ color: 'var(--text-2)' }}>{children}</div></Card>;
  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <h1 className="display text-3xl font-semibold">User manual</h1>
      <S t="0 · Introduction to Operations Research">
        <p><b>Origin.</b> Operations Research began in Britain in the late 1930s and in the Second World War, when scientists were asked to make scarce military resources (radar, convoys, aircraft) go further. After the war the same scientific, model-based approach moved into industry, transport and management.</p>
        <p><b>Definition.</b> OR is the use of mathematical models and algorithms to find the best, or a good, decision in a complex situation. The decision is judged by a <b>performance measure</b> (profit, cost, time, waiting…) that is maximised or minimised.</p>
        <p><b>Phases of an OR study.</b> 1 Define the problem and the objective · 2 Collect data and observe the system · 3 Formulate a mathematical model · 4 Solve the model · 5 Validate the model and the solution · 6 Implement and monitor the result.</p>
        <p><b>Types of OR problems.</b> <i>Deterministic</i> models treat every input as known: linear, integer and nonlinear programming, transportation, assignment, shortest paths and flows, CPM, sequencing. <i>Stochastic</i> models include randomness: queuing, inventory under uncertain demand, PERT, Markov chains, game theory and simulation.</p>
        <p><b>Inventory models vs linear programming.</b> An LP chooses several quantities at once to optimise a linear objective under linear constraints (product mix, blending, diet). An inventory model has one main decision — how much to order and when — and its cost is a nonlinear trade-off between ordering and holding (the EOQ curve), usually solved by a formula or calculus rather than by the simplex method. Both appear in production planning: LP decides <i>what</i> to make with limited resources; inventory models decide <i>how much stock</i> to keep and how often to reorder.</p>
      </S>
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
      <S t="6 · Syllabus map (course 702CO0E034, Operations Research)">
        <p>Where each unit of the syllabus lives in OR/Studio.</p>
        <div className="overflow-x-auto">
          <table className="tbl text-[0.88rem]">
            <thead><tr><th scope="col" className="rowhead">Unit and topic</th><th scope="col" className="rowhead">Where in the app</th></tr></thead>
            <tbody>
              <tr><th scope="row">1 · Introduction to OR</th><td className="rowhead">Section 0 of this manual</td></tr>
              <tr><th scope="row">2 · LP: formulation, matrix form, extreme points, basic feasible solutions</th><td className="rowhead"><a className="underline" href={href('/m/lp')}>Linear programming</a> → Model, Basic solutions tab</td></tr>
              <tr><th scope="row">2 · Graphical method and its special cases</th><td className="rowhead"><a className="underline" href={href('/m/lp')}>Linear programming</a> → Graphical tab (infeasible, unbounded, redundant, degenerate examples in the library)</td></tr>
              <tr><th scope="row">2 · Simplex, Big-M, two-phase, dual simplex</th><td className="rowhead"><a className="underline" href={href('/m/lp')}>Linear programming</a> → Method switch</td></tr>
              <tr><th scope="row">2 · Sensitivity analysis and duality</th><td className="rowhead"><a className="underline" href={href('/m/lp')}>Linear programming</a> → Sensitivity and Duality tabs</td></tr>
              <tr><th scope="row">3 · Gomory cuts, branch and bound</th><td className="rowhead"><a className="underline" href={href('/m/integer')}>Integer programming</a></td></tr>
              <tr><th scope="row">4 · Transportation: NWCR, least cost, VAM, MODI, variations</th><td className="rowhead"><a className="underline" href={href('/m/transport')}>Transportation</a></td></tr>
              <tr><th scope="row">4 · Assignment: Hungarian, variations</th><td className="rowhead"><a className="underline" href={href('/m/assign')}>Assignment</a></td></tr>
              <tr><th scope="row">5 · CPM, PERT, crashing</th><td className="rowhead"><a className="underline" href={href('/m/project')}>Project planning</a> (and <a className="underline" href={href('/m/network')}>Network models</a>)</td></tr>
              <tr><th scope="row">6 · Two-person zero-sum games</th><td className="rowhead"><a className="underline" href={href('/m/games')}>Zero-sum games</a></td></tr>
              <tr><th scope="row">7 · Simulation: random numbers, generators, demand tables, inventory systems</th><td className="rowhead"><a className="underline" href={href('/m/simulation')}>Simulation</a> → Demand table, Inventory, RNG lab</td></tr>
              <tr><th scope="row">7 · Discrete-event simulation (clock, event list), queuing systems</th><td className="rowhead"><a className="underline" href={href('/m/simulation')}>Simulation</a> → Queue sim; <a className="underline" href={href('/m/queuing')}>Queuing analysis</a></td></tr>
              <tr><th scope="row">7 · n jobs through two, three and m machines</th><td className="rowhead"><a className="underline" href={href('/m/sequencing')}>Job sequencing</a></td></tr>
            </tbody>
          </table>
        </div>
        <p><b>Experiment 10 (simulation models).</b> Activity 1 → Simulation → Demand table (library: stationery demand). Activity 2 → Simulation → RNG lab (methods and website references). Activity 4 → Job sequencing (library: Experiment 10). Activity 5 → Job sequencing with three machines, and Assignment for the job–machine assignment view.</p>
      </S>
      <S t="7 · Hover explanations">
        <p>Hover over (or tap, or focus with the keyboard) any short form — column headings such as RHS, ES, EF or Lₛ, symbols such as ρ and λ, variable names such as s₁ (slack) and a₁ (artificial), and method names such as VAM or MODI — to see what it means.</p>
      </S>
      <S t="8 · Accessibility">
        <p>Every control is keyboard reachable; step changes are announced to screen readers; tables have headers and captions; colours are always paired with icons or text; animations respect <i>reduce motion</i>.</p>
      </S>
    </div>
  );
}
