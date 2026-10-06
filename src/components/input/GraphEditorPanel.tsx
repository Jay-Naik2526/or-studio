import { MousePointer2, CircleDot, Spline, Trash2, Plus } from 'lucide-react';
import { GraphSpec } from '../../data/specs';
import { parseNum } from '../../lib/numbers';
import { Btn, Card } from '../ui/ui';
import { Tool } from '../viz/GraphCanvas';

interface Props { spec: GraphSpec; onChange: (g: GraphSpec) => void; tool: Tool; onTool: (t: Tool) => void; showCapacity?: boolean; showWeight?: boolean; multiTerminals?: boolean; needSource?: boolean; top?: React.ReactNode; actions?: React.ReactNode }

export function GraphEditorPanel({ spec, onChange, tool, onTool, showCapacity, showWeight = true, multiTerminals, needSource = true, top, actions }: Props) {
  const tools: { t: Tool; icon: React.ReactNode; label: string }[] = [
    { t: 'select', icon: <MousePointer2 size={14} />, label: 'Move' }, { t: 'node', icon: <CircleDot size={14} />, label: 'Add node' },
    { t: 'edge', icon: <Spline size={14} />, label: 'Add edge' }, { t: 'delete', icon: <Trash2 size={14} />, label: 'Delete' },
  ];
  const setEdge = (i: number, patch: Partial<GraphSpec['edges'][number]>) => onChange({ ...spec, edges: spec.edges.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
  const toggle = (arr: string[], id: string) => (arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]);
  const bad = (s: string) => !parseNum(s).ok;
  return (
    <Card title="Graph" right={<span className="text-[13px] normal-case tracking-normal font-normal muted">{spec.nodes.length} nodes · {spec.edges.length} edges</span>}>
      <div className="grid gap-5 lg:grid-cols-2 items-start">
      <div className="flex flex-col gap-3">
        {top}
        <div role="toolbar" aria-label="Drawing tools" className="flex flex-wrap gap-1">
          {tools.map(t => <Btn key={t.t} size="sm" aria-pressed={tool === t.t} onClick={() => onTool(t.t)} title={t.label}>{t.icon}{t.label}</Btn>)}
        </div>
        <p className="text-[13px] muted">{tool === 'node' ? 'Click the canvas to drop a node.' : tool === 'edge' ? 'Click one node, then another, to connect them.' : tool === 'delete' ? 'Click a node or an edge to remove it.' : 'Drag nodes to rearrange them.'}</p>
        {needSource && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            {!multiTerminals ? <>
              <label className="flex flex-col gap-1">Source<select className="select" value={spec.source} onChange={e => onChange({ ...spec, source: e.target.value })}><option value="">—</option>{spec.nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select></label>
              <label className="flex flex-col gap-1">Sink / target<select className="select" value={spec.sink} onChange={e => onChange({ ...spec, sink: e.target.value })}><option value="">—</option>{spec.nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select></label>
            </> : <>
              <fieldset className="flex flex-col gap-1"><legend className="font-semibold mb-1">Sources</legend><div className="flex flex-wrap gap-1">{spec.nodes.map(n => <label key={n.id} className="badge cursor-pointer"><input type="checkbox" checked={spec.sources.includes(n.id) || (spec.sources.length === 0 && spec.source === n.id)} onChange={() => onChange({ ...spec, sources: toggle(spec.sources.length ? spec.sources : spec.source ? [spec.source] : [], n.id), source: '' })} /> {n.label}</label>)}</div></fieldset>
              <fieldset className="flex flex-col gap-1"><legend className="font-semibold mb-1">Sinks</legend><div className="flex flex-wrap gap-1">{spec.nodes.map(n => <label key={n.id} className="badge cursor-pointer"><input type="checkbox" checked={spec.sinks.includes(n.id) || (spec.sinks.length === 0 && spec.sink === n.id)} onChange={() => onChange({ ...spec, sinks: toggle(spec.sinks.length ? spec.sinks : spec.sink ? [spec.sink] : [], n.id), sink: '' })} /> {n.label}</label>)}</div></fieldset>
            </>}
          </div>
        )}
        {spec.nodes.length > 0 && (
          <details className="text-[0.85rem]">
            <summary className="cursor-pointer font-semibold select-none">Rename nodes</summary>
            <div className="flex flex-wrap gap-2 pt-2">
              {spec.nodes.map(n => {
                const dup = spec.nodes.some(o => o.id !== n.id && o.label.trim() === n.label.trim());
                return <input key={n.id} className="input num !w-16" aria-label={`Name of node ${n.id}`} aria-invalid={dup || n.label.trim() === ''} value={n.label} maxLength={6} onChange={e => onChange({ ...spec, nodes: spec.nodes.map(x => (x.id === n.id ? { ...x, label: e.target.value } : x)) })} />;
              })}
            </div>
          </details>
        )}
      </div>
      <div className="flex flex-col gap-3 min-w-0">
        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <table className="tbl text-xs" aria-label="Edge list">
            <thead><tr><th scope="col">From</th><th scope="col">To</th>{showWeight && <th scope="col">Weight</th>}{showCapacity && <th scope="col">Cap.</th>}<th scope="col" title="directed">→</th><th scope="col"><span className="sr-only">Delete</span></th></tr></thead>
            <tbody>
              {spec.edges.map((e, i) => (
                <tr key={e.id}>
                  <td className="!p-0.5"><select className="select !w-14" aria-label={`Edge ${i + 1} from`} value={e.from} onChange={ev => setEdge(i, { from: ev.target.value })}>{spec.nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select></td>
                  <td className="!p-0.5"><select className="select !w-14" aria-label={`Edge ${i + 1} to`} value={e.to} onChange={ev => setEdge(i, { to: ev.target.value })}>{spec.nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select></td>
                  {showWeight && <td className="!p-0.5"><input className="input num !w-14" aria-label={`Edge ${i + 1} weight`} aria-invalid={bad(e.weight)} value={e.weight} onChange={ev => setEdge(i, { weight: ev.target.value, capacity: showCapacity ? e.capacity : ev.target.value })} /></td>}
                  {showCapacity && <td className="!p-0.5"><input className="input num !w-14" aria-label={`Edge ${i + 1} capacity`} aria-invalid={bad(e.capacity)} value={e.capacity} onChange={ev => setEdge(i, { capacity: ev.target.value })} /></td>}
                  <td className="!p-0.5"><input type="checkbox" aria-label={`Edge ${i + 1} directed`} checked={e.directed} onChange={ev => setEdge(i, { directed: ev.target.checked })} /></td>
                  <td className="!p-0.5"><Btn size="icon" variant="ghost" aria-label={`Delete edge ${i + 1}`} onClick={() => onChange({ ...spec, edges: spec.edges.filter((_, k) => k !== i) })}><Trash2 size={12} /></Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Btn size="sm" onClick={() => { if (spec.nodes.length < 2) return; let k = spec.edges.length + 1; while (spec.edges.some(x => x.id === `e${k}`)) k++; onChange({ ...spec, edges: [...spec.edges, { id: `e${k}`, from: spec.nodes[0]!.id, to: spec.nodes[1]!.id, weight: '1', capacity: '1', directed: false }] }); }}><Plus size={12} /> Edge row</Btn>
          <label className="btn btn-sm cursor-pointer">Import matrix…<input type="file" className="sr-only" accept=".csv,.txt" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; const rows = (await f.text()).trim().split(/\r?\n/).map(r => r.split(/[,\t;\s]+/)); const n = rows.length; if (!n || rows.some(r => r.length !== n)) return; const nodes = Array.from({ length: n }, (_, i) => ({ id: String(i + 1), label: String(i + 1), x: Math.round(320 + 140 * Math.cos((2 * Math.PI * i) / n - Math.PI / 2)), y: Math.round(190 + 140 * Math.sin((2 * Math.PI * i) / n - Math.PI / 2)) })); const edges: GraphSpec['edges'] = []; rows.forEach((r, i) => r.forEach((c, j) => { if (i !== j && c !== '' && c !== '0' && c.toLowerCase() !== 'inf' && c !== '∞' && !Number.isNaN(Number(c))) edges.push({ id: `e${edges.length + 1}`, from: String(i + 1), to: String(j + 1), weight: c, capacity: c, directed: true }); })); onChange({ ...spec, nodes, edges, source: '1', sink: String(n), sources: [], sinks: [] }); e.target.value = ''; }} /></label>
          {actions}
        </div>
      </div>
      </div>
    </Card>
  );
}
