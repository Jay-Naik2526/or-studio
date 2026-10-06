import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts';
import { BBState } from '../../core/types/models';
import { Card } from '../ui/ui';
import { TrendingUp } from 'lucide-react';

export function IncumbentChart({ states, upTo, rootBound }: { states: BBState[]; upTo: number; rootBound: number | null }) {
  const data = states.slice(0, upTo + 1).map((s, i) => ({
    step: i + 1,
    incumbent: s.incumbent ? Number(s.incumbent.objective.toDecimal(6)) : null,
    bound: s.bestBound ? Number(s.bestBound.toDecimal(6)) : null,
  }));
  return (
    <Card title="Incumbent and bound evolution" icon={<TrendingUp size={14} />} bodyClass="p-2">
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="step" tick={{ fontSize: 10, fill: 'var(--text-3)' }} label={{ value: 'step', position: 'insideBottomRight', fontSize: 10, fill: 'var(--text-3)' }} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--text-3)' }} domain={['auto', 'auto']} width={44} />
            <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} />
            {rootBound !== null && <ReferenceLine y={rootBound} stroke="var(--leaving)" strokeDasharray="5 3" label={{ value: 'LP bound', fontSize: 10, fill: 'var(--leaving)', position: 'insideTopRight' }} />}
            <Line type="stepAfter" dataKey="bound" name="best bound" stroke="var(--entering)" dot={false} strokeWidth={2} connectNulls />
            <Line type="stepAfter" dataKey="incumbent" name="incumbent" stroke="var(--ok)" dot={{ r: 3 }} strokeWidth={2.5} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[13px] muted px-2">The gap between the incumbent (best integer solution found) and the best bound (best value any open node could still reach) shrinks to zero when optimality is proven.</p>
    </Card>
  );
}
