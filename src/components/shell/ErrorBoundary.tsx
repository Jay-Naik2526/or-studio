import { Component, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { clearAutosave } from '../../lib/persist';

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null; key?: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(p: { resetKey?: string }, s: { key?: string; error: Error | null }) {
    return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null;
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="callout callout-bad" role="alert">
        <AlertTriangle size={18} className="shrink-0" />
        <div>
          <div className="font-bold">Something went wrong in this view.</div>
          <div className="text-sm mt-1">{this.state.error.message}</div>
          <p className="text-[0.88rem] mt-2">If this keeps happening, the saved or shared model for this module may be damaged. Resetting clears only this module's autosave.</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
            <button className="btn" onClick={() => { const m = window.location.hash.match(/#\/m\/([a-z]+)/); if (m) clearAutosave(m[1]!); window.location.hash = m ? `#/m/${m[1]}` : '#/'; window.location.reload(); }}>Reset this module</button>
            <a className="btn" href="#/">Back to the overview</a>
          </div>
        </div>
      </div>
    );
  }
}
