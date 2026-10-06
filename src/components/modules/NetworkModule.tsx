import { useEffect, useMemo, useRef, useState } from 'react';
import { Share2, GitCompare, Trash2 } from 'lucide-react';
import { GraphModel, GraphState, SavedModel } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { solveDijkstra, solveBellmanFord, solveFloydWarshall, solveMST, solveMaxFlow, PathResult, FloydResult, MSTResult, MaxFlowResult } from '../../core/solvers/network/network';
import { Solution } from '../../core/types/solver';
import { libraryFor } from '../../data/library';
import { GraphSpec } from '../../data/specs';
import { parseNum } from '../../lib/numbers';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { TutorPanel, TutorQuestion, useTutorStats } from '../workspace/TutorPanel';
import { GridDiff } from '../workspace/GridDiff';
import { GraphCanvas, Tool } from '../viz/GraphCanvas';
import { GraphEditorPanel } from '../input/GraphEditorPanel';
import { Card, Callout, StatusBanner, statusKind, statusLabel, DiagnosticsList, Badge, Btn } from '../ui/ui';
import { Q } from '../ui/Q';
import { useInitial, useSaved, stepsToReport, diagText, clampStep } from './common';

type Variant = 'dijkstra' | 'bellman' | 'floyd' | 'kruskal' | 'prim' | 'maxflow';
const VARIANTS: { value: Variant; label: string; title: string }[] = [
  { value: 'dijkstra', label: 'Dijkstra', title: 'Shortest path, non-negative weights' }, { value: 'bellman', label: 'Bellman–Ford', title: 'Shortest path, negative weights allowed' },
  { value: 'floyd', label: 'Floyd', title: 'All pairs' }, { value: 'kruskal', label: 'Kruskal', title: 'Minimum spanning tree' }, { value: 'prim', label: 'Prim', title: 'Minimum spanning tree' }, { value: 'maxflow', label: 'Max flow', title: 'Edmonds–Karp' },
];

const DEFAULT: GraphSpec = libraryFor('network')[0]!.spec as GraphSpec;

export function toGraphModel(spec: GraphSpec, flow = false): { model: GraphModel | null; error: string | null } {
  const edges: GraphModel['edges'] = [];
  const nm = (id: string) => spec.nodes.find(n => n.id === id)?.label ?? id;
  for (const e of spec.edges) {
    if (flow) {
      const c = parseNum(e.capacity);
      if (!c.ok) return { model: null, error: `Edge ${nm(e.from)}–${nm(e.to)}: capacity ${c.error === 'empty' ? 'is missing' : c.error}` };
      edges.push({ id: e.id, from: e.from, to: e.to, weight: c.value, capacity: c.value, directed: e.directed });
      continue;
    }
    const w = parseNum(e.weight);
    if (!w.ok) return { model: null, error: `Edge ${nm(e.from)}–${nm(e.to)}: weight ${w.error === 'empty' ? 'is missing' : w.error}` };
    edges.push({ id: e.id, from: e.from, to: e.to, weight: w.value, capacity: w.value, directed: e.directed });
  }
  const labels = spec.nodes.map(n => n.label.trim());
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup !== undefined) return { model: null, error: `Two nodes are both called “${dup}” — give every node a unique name.` };
  return { model: { nodes: spec.nodes.map(n => ({ id: n.id, label: n.label, x: n.x, y: n.y })), edges, source: spec.source || undefined, sink: spec.sink || undefined, sources: spec.sources.length ? spec.sources : undefined, sinks: spec.sinks.length ? spec.sinks : undefined }, error: null };
}

export default function NetworkModule() {
  const init = useInitial<GraphSpec>('network', DEFAULT);
  const [spec, setSpec] = useState<GraphSpec>(init.spec);
  const [variant, setVariant] = useState<Variant>((VARIANTS.some(v => v.value === init.variant) ? init.variant : 'dijkstra') as Variant);
  const [mode, setMode] = useState<'auto' | 'tutor'>('auto');
  const [tool, setTool] = useState<Tool>('select');
  const [dfs, setDfs] = useState(false);
  const [step, setStep] = useState(init.step);
  const pngRef = useRef<HTMLElement | null>(null);
  const { model, error } = useMemo(() => toGraphModel(spec, variant === 'maxflow'), [spec, variant]);

  const sol = useMemo<Solution<GraphState, unknown> | null>(() => {
    if (!model) return null;
    switch (variant) {
      case 'dijkstra': return solveDijkstra(model, { variant: 'all' }) as Solution<GraphState, unknown>;
      case 'bellman': return solveBellmanFord(model) as Solution<GraphState, unknown>;
      case 'floyd': return solveFloydWarshall(model) as Solution<GraphState, unknown>;
      case 'kruskal': return solveMST(model, 'kruskal') as Solution<GraphState, unknown>;
      case 'prim': return solveMST(model, 'prim') as Solution<GraphState, unknown>;
      default: return solveMaxFlow(model, { dfs }) as Solution<GraphState, unknown>;
    }
  }, [model, variant, dfs]);
  const steps = sol?.steps ?? [];
  const idx = clampStep(step, steps.length);
  const saved = useSaved('network', spec, variant);
  const onLoad = (m: SavedModel) => { setSpec(m.model as GraphSpec); if (m.variant) setVariant(m.variant as Variant); setStep(0); };
  useEffect(() => { setStep(0); }, [variant]);
  // switching between single-terminal and multi-terminal views must not lose the chosen nodes
  const changeVariant = (v: Variant) => {
    setSpec(g => (v === 'maxflow'
      ? g
      : { ...g, source: g.source || g.sources[0] || '', sink: g.sink || g.sinks[0] || '' }));
    setVariant(v);
  };

  const [tIdx, setTIdx] = useState(0);
  const tstats = useTutorStats();
  useEffect(() => { setTIdx(0); tstats.reset(); }, [spec, variant, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const nm = (id: string) => model?.nodes.find(n => n.id === id)?.label ?? id;
  // index of the next step that is worth asking about (relaxations etc. are skipped silently)
  const qi = useMemo(() => {
    if (mode !== 'tutor') return -1;
    for (let t = tIdx; t < steps.length - 1; t++) {
      const nxt = steps[t + 1]!;
      if (variant === 'dijkstra' && nxt.action?.kind === 'permanent') return t;
      if (variant === 'kruskal' && (nxt.explanation.rule === 'Cycle test passed' || nxt.explanation.rule === 'Cycle test failed')) return t;
    }
    return -1;
  }, [mode, steps, tIdx, variant]);
  const question = useMemo<TutorQuestion | null>(() => {
    if (mode !== 'tutor' || !model || qi < 0) return null;
    const cur = steps[qi], nxt = steps[qi + 1];
    if (!cur || !nxt) return null;
    const st = cur.state as GraphState;
    if (variant === 'dijkstra' && nxt.action?.kind === 'permanent') {
      const node = (nxt.action.payload as { node: string }).node;
      const cand = Object.entries(st.nodeLabels).filter(([, l]) => !l.permanent && l.value !== null);
      return { id: `d${qi}`, prompt: 'Which node gets a PERMANENT label next?', hint: 'The unfinished node with the smallest tentative distance.', options: cand.map(([id, l]) => ({ id, label: `${nm(id)} (${l.value!.toString()})`, correct: id === node, feedback: id === node ? nxt.explanation.short : `${nm(id)} has tentative distance ${l.value!.toString()}, but another node is closer to the source.`, misconception: 'Dijkstra always finalises the smallest tentative label — not the nearest neighbour of the last node.' })), reveal: nxt.explanation.short };
    }
    if (variant === 'kruskal') {
      const e = model.edges.find(x => nxt.highlights.some(h => h.target === `edge:${x.id}`));
      if (!e) return null;
      const ok = nxt.explanation.rule === 'Cycle test passed';
      return { id: `k${qi}`, prompt: `Next lightest edge: ${nm(e.from)}–${nm(e.to)} (weight ${e.weight.toString()}). Accept it or reject it?`, hint: 'Reject an edge exactly when its endpoints are already connected by chosen edges.', options: [{ id: 'a', label: 'Accept (connects two components)', correct: ok, feedback: ok ? nxt.explanation.short : 'These nodes are already connected through chosen edges — adding the edge would close a cycle.', misconception: 'A cycle appears when both endpoints are already in the same component.' }, { id: 'r', label: 'Reject (would form a cycle)', correct: !ok, feedback: !ok ? nxt.explanation.short : 'The endpoints are in different components, so the edge is safe to add.', misconception: 'Reject only when it would create a cycle, not because it is heavy.' }], reveal: nxt.explanation.short };
    }
    return null;
  }, [mode, model, steps, qi, variant]);
  const advance = () => setTIdx(qi + 1);
  const tutorable = variant === 'dijkstra' || variant === 'kruskal';

  const showSt = mode === 'tutor' && tutorable ? steps[qi >= 0 ? qi : steps.length - 1] : steps[idx];
  const cur = steps[idx];
  const result = sol?.result as unknown;

  const buildReport = () => {
    if (!sol || !model) return null;
    const gs = (s: GraphState) => (s.distMatrix ? { headers: ['', ...(s.nodeOrder ?? [])], rows: s.distMatrix.map((r, i) => [s.nodeOrder![i]!, ...r.map(v => (v ? v.toString() : '∞'))]) } : Object.keys(s.nodeLabels).length ? { headers: ['Node', 'Label', 'Permanent'], rows: Object.entries(s.nodeLabels).map(([id, l]) => [nm(id), l.value ? l.value.toString() : '∞', l.permanent ? 'yes' : '']) } : undefined);
    const lines: string[] = [];
    if (variant === 'dijkstra' || variant === 'bellman') { const r = result as PathResult | null; if (r) lines.push(r.path.length ? `Shortest route: ${r.path.map(nm).join(' → ')} = ${r.totalDistance?.toString()}` : 'No route.'); }
    if (variant === 'kruskal' || variant === 'prim') { const r = result as MSTResult | null; if (r) lines.push(`Total weight = ${r.totalWeight.toString()}`, `Edges: ${r.selectedEdges.map(id => { const e = model.edges.find(x => x.id === id)!; return `${nm(e.from)}–${nm(e.to)}`; }).join(', ')}`); }
    if (variant === 'maxflow') { const r = result as MaxFlowResult | null; if (r) lines.push(`Maximum flow = ${r.maxFlow.toString()}`, `Min cut capacity = ${r.cutCapacity.toString()}`); }
    return { title: 'Network problem', module: 'Network models', method: VARIANTS.find(v => v.value === variant)!.label, problem: `Nodes: ${spec.nodes.map(n => n.label).join(', ')}\nEdges:\n${spec.edges.map(e => `  ${nm(e.from)} ${e.directed ? '→' : '—'} ${nm(e.to)}  weight ${e.weight}${variant === 'maxflow' ? `  capacity ${e.capacity}` : ''}`).join('\n')}`, steps: stepsToReport(steps, gs), result: { heading: `Result: ${statusLabel(sol.status)}`, lines: lines.length ? lines : [statusLabel(sol.status)] }, diagnostics: diagText(sol.diagnostics) };
  };

  const headline = (() => {
    if (!result) return null;
    if (variant === 'dijkstra' || variant === 'bellman') { const r = result as PathResult; return r.totalDistance ? <span className="mono font-bold text-base">{r.path.map(nm).join(' → ')} = <Q v={r.totalDistance} /></span> : null; }
    if (variant === 'kruskal' || variant === 'prim') { const r = result as MSTResult; return <span className="mono font-bold text-base">weight = <Q v={r.totalWeight} /></span>; }
    if (variant === 'maxflow') { const r = result as MaxFlowResult; return <span className="mono font-bold text-base">max flow = <Q v={r.maxFlow} /> = min cut</span>; }
    return null;
  })();
  const status = sol && <StatusBanner kind={statusKind(sol.status)} label={statusLabel(sol.status)}>{headline}</StatusBanner>;
  const gstate = showSt?.state as GraphState | undefined;
  const floyd = result as FloydResult | null;

  const tabs = [
    { id: 'graph', label: <><Share2 size={13} /> Graph</>, node: <>
      {error && <Callout kind="bad">{error}</Callout>}
      <Card title={showSt?.phase ?? 'Graph'} bodyClass="p-2" right={variant === 'maxflow' ? <label className="flex items-center gap-1 text-[13px] normal-case tracking-normal font-medium"><input type="checkbox" checked={dfs} onChange={e => setDfs(e.target.checked)} /> depth-first (Ford–Fulkerson)</label> : undefined}>
        <GraphCanvas spec={spec} state={gstate} highlights={showSt?.highlights} flowMode={variant === 'maxflow'} onChange={mode === 'auto' ? setSpec : undefined} tool={tool} />
      </Card>
      {mode === 'tutor' && tutorable && <TutorPanel question={question} stats={tstats.stats} onResult={tstats.record} onAdvance={advance} finishedText="The algorithm has finished." />}
      {mode === 'tutor' && !tutorable && <Callout kind="info">Tutor questions are available for Dijkstra and Kruskal. Showing the full run instead — use Auto mode for the other algorithms.</Callout>}
      {variant === 'floyd' && gstate?.distMatrix && (
        <Card title="Distance matrix D" bodyClass="p-2"><div className="overflow-x-auto"><table className="tbl"><thead><tr><th scope="col" />{gstate.nodeOrder!.map(id => <th key={id} scope="col" className={gstate.pivotNode === id ? 'col-enter' : ''}>{nm(id)}</th>)}</tr></thead><tbody>{gstate.distMatrix.map((r, i) => <tr key={i}><th scope="row" className={gstate.pivotNode === gstate.nodeOrder![i] ? 'row-leave' : ''}>{nm(gstate.nodeOrder![i]!)}</th>{r.map((v, j) => { const hot = showSt?.highlights.some(h => h.target === `cell:${i},${j}`); return <td key={j} className={`${hot ? 'pivot' : ''} ${i === j ? 'muted' : ''}`}>{v ? <Q v={v} /> : '∞'}</td>; })}</tr>)}</tbody></table></div></Card>
      )}
      {(variant === 'dijkstra' || variant === 'bellman') && result != null && idx === steps.length - 1 && (
        <Card title="Distances from the source" bodyClass="p-2"><div className="overflow-x-auto"><table className="tbl"><thead><tr><th scope="col">Node</th><th scope="col">Distance</th><th scope="col">Via</th></tr></thead><tbody>{model!.nodes.map(n => { const r = result as PathResult; const d = r.distances[n.id]; return <tr key={n.id}><th scope="row">{n.label}</th><td className={d ? 'font-bold' : 'muted'}>{d ? <Q v={d} /> : '∞ (unreachable)'}</td><td>{r.predecessor[n.id] ? nm(r.predecessor[n.id]!) : '—'}</td></tr>; })}</tbody></table></div></Card>
      )}
      {variant === 'maxflow' && result != null && idx === steps.length - 1 && (
        <Card title="Flow on each edge and minimum cut" bodyClass="p-2"><div className="overflow-x-auto"><table className="tbl"><thead><tr><th scope="col">Edge</th><th scope="col">Flow</th><th scope="col">Capacity</th><th scope="col">Status</th></tr></thead><tbody>{model!.edges.map(e => { const r = result as MaxFlowResult; const f = r.flows[e.id] ?? Rational.ZERO; return <tr key={e.id}><th scope="row">{nm(e.from)}{e.directed ? '→' : '–'}{nm(e.to)}</th><td className="font-bold"><Q v={f} /></td><td><Q v={e.capacity} /></td><td>{r.cutEdges.includes(e.id) ? <Badge kind="bad">min cut</Badge> : f.eq(e.capacity!) ? <Badge kind="warn">saturated</Badge> : ''}</td></tr>; })}</tbody></table></div></Card>
      )}
      {floyd && variant === 'floyd' && idx === steps.length - 1 && !floyd.negativeCycle && (
        <Card title="Routes between any pair" bodyClass="p-2"><div className="grid sm:grid-cols-2 gap-1 text-[0.82rem] mono max-h-56 overflow-auto">{floyd.nodes.flatMap((a, i) => floyd.nodes.map((b, j) => (i !== j ? <div key={`${i}-${j}`}>{nm(a)}→{nm(b)}: {floyd.path(i, j).length ? floyd.path(i, j).map(k => nm(floyd.nodes[k]!)).join('→') + ` (${floyd.dist[i]![j]!.toString()})` : 'no route'}</div> : null)))}</div></Card>
      )}
    </> },
    { id: 'diff', label: <><GitCompare size={13} /> Diff mode</>, node: <GridDiff title="Compare your node labels / matrix" blankLabel="blank = ∞ / none" steps={steps} extract={(s: GraphState) => (s.distMatrix ? { rowLabels: s.nodeOrder!.map(nm), colLabels: s.nodeOrder!.map(nm), cells: s.distMatrix.map(r => r.map(v => (v ? v.toString() : null))) } : { rowLabels: ['label'], colLabels: Object.keys(s.nodeLabels).map(nm), cells: [Object.values(s.nodeLabels).map(l => (l.value ? l.value.toString() : null))] })} /> },
  ];

  return (
    <WorkspaceFrame
      moduleId="network" title="Network models" accent="#0891b2" subtitle="Draw the graph · shortest paths · spanning trees · maximum flow"
      variants={VARIANTS} variant={variant} onVariant={changeVariant} mode={mode} onMode={setMode}
      input={<>
        <GraphEditorPanel spec={spec} onChange={setSpec} tool={tool} onTool={setTool} showCapacity={variant === 'maxflow'} multiTerminals={variant === 'maxflow'} needSource={variant !== 'kruskal' && variant !== 'floyd'} showWeight={variant !== 'maxflow'}
          top={<label className="flex items-center gap-2 text-[0.9rem] font-semibold">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('network')[Number(e.target.value)]; if (x) { setSpec(structuredClone(x.spec) as GraphSpec); if (x.variant) setVariant(x.variant as Variant); setStep(0); } }}><option value="" disabled>Choose…</option>{libraryFor('network').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>}
          actions={<Btn size="sm" className="ml-auto" onClick={() => setSpec({ nodes: [], edges: [], source: '', sink: '', sources: [], sinks: [] })}><Trash2 size={12} /> Clear graph</Btn>} />
        {sol && sol.diagnostics.length > 0 && <DiagnosticsList items={sol.diagnostics} />}
      </>}
      tabs={tabs} side={showSt ? <ExplanationPanel explanation={showSt.explanation} phase={showSt.phase} /> : <Card><p className="text-sm muted">{sol?.diagnostics[0]?.message ?? 'Draw a graph and choose a source.'}</p></Card>}
      player={(mode === 'auto' || !tutorable) && steps.length > 0 ? <StepPlayer count={steps.length} index={idx} onChange={setStep} labels={steps.map(s => s.phase ?? '')} summary={cur?.explanation.short} /> : undefined}
      status={status} saved={saved} onLoad={onLoad} buildReport={buildReport} pngRef={pngRef} step={idx}
    />
  );
}
