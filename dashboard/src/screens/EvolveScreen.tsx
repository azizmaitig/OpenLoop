import { useState, useEffect, useCallback } from 'react';

export function EvolveScreen() {
  const [content, setContent] = useState<string>('');
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchProposals = useCallback(() => {
    setLoading(true);
    fetch('/api/evolve-proposals')
      .then((r) => r.json())
      .then((data) => {
        setContent(data.content ?? '');
        setExists(data.exists ?? false);
      })
      .catch(() => { setContent(''); setExists(false); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchProposals(); }, [fetchProposals]);

  return (
    <div className="stack">
      <div className="refresh-bar">
        <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          {exists ? 'Proposals available' : 'No proposals yet'}
        </span>
        <button className="pagebtn" onClick={fetchProposals} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {loading && <div className="card"><p className="sub">Loading...</p></div>}

      {!loading && !exists && (
        <div className="card">
          <p className="sub">No evolve proposals found at <code>.build/spec-evolve/spec-evolve-proposals.md</code></p>
          <p className="sub">Proposals appear here after L3 runs and generates a proposal.</p>
        </div>
      )}

      {!loading && exists && (
        <div className="card">
          <h3 style={{ margin: '0 0 8px' }}>Evolve Proposals</h3>
          <div className="evolve-proposal-content" style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--text)',
            overflowX: 'auto',
          }}>
            {content}
          </div>
        </div>
      )}
    </div>
  );
}
