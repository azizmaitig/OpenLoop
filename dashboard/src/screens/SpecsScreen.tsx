import { useState, useEffect, useCallback } from 'react';

interface SpecEntry {
  id: string;
  title: string;
  status: string;
  specNum: string;
  hasBuiltDir: boolean;
}

const STATUS_ORDER: Record<string, number> = {
  'Draft': 0,
  'Reviewed': 1,
  'Approved': 2,
  'In Progress': 3,
  'Implemented': 4,
  'Verified': 5,
  'Built': 6,
  'Completed': 7,
};

const STATUS_COLORS: Record<string, string> = {
  'Draft': 'var(--text-dim)',
  'Reviewed': 'var(--accent)',
  'Approved': 'var(--warn)',
  'In Progress': 'var(--warn)',
  'Implemented': 'var(--pass)',
  'Verified': 'var(--ok)',
  'Built': 'var(--ok)',
  'Completed': 'var(--ok)',
};

function statusBadgeColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--text-dim)';
}

function SpecCard({ spec, onSelect }: { spec: SpecEntry; onSelect: (id: string) => void }) {
  return (
    <div
      className="spec-card"
      onClick={() => onSelect(spec.id)}
      style={{ cursor: 'pointer' }}
    >
      <div className="spec-card-header">
        <span className="spec-num">{spec.specNum}</span>
        <span
          className="spec-status-badge"
          style={{
            background: statusBadgeColor(spec.status) + '22',
            color: statusBadgeColor(spec.status),
            border: '1px solid ' + statusBadgeColor(spec.status) + '44',
          }}
        >
          {spec.status}
        </span>
        {spec.hasBuiltDir && <span className="spec-built-badge">built</span>}
      </div>
      <div className="spec-card-title">{spec.title}</div>
    </div>
  );
}

function SpecDetail({ specId, onBack }: { specId: string; onBack: () => void }) {
  const [spec, setSpec] = useState<SpecEntry | null>(null);

  useEffect(() => {
    fetch('/api/specs')
      .then((r) => r.json())
      .then((data) => {
        const found = (data.specs ?? []).find((s: SpecEntry) => s.id === specId);
        setSpec(found ?? null);
      })
      .catch(() => setSpec(null));
  }, [specId]);

  if (!spec) return <div className="card"><p>Loading...</p></div>;

  return (
    <div className="card">
      <button className="pagebtn" onClick={onBack} style={{ marginBottom: 12 }}>&larr; Back</button>
      <h2 style={{ margin: '0 0 8px' }}>{spec.title}</h2>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <span className="spec-status-badge" style={{
          background: statusBadgeColor(spec.status) + '22',
          color: statusBadgeColor(spec.status),
          border: '1px solid ' + statusBadgeColor(spec.status) + '44',
        }}>{spec.status}</span>
        {spec.hasBuiltDir && <span className="spec-built-badge">built</span>}
      </div>
      <p className="sub">Directory: <code>{spec.id}</code></p>
      <p className="sub">All tasks referencing this spec in history will appear here.</p>
    </div>
  );
}

export function SpecsScreen() {
  const [specs, setSpecs] = useState<SpecEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSpec, setSelectedSpec] = useState<string | null>(null);

  const loadSpecs = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/specs')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); setSpecs([]); }
        else { setSpecs(data.specs ?? []); }
      })
      .catch((err) => setError(err.message ?? 'Failed to load specs'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSpecs(); }, [loadSpecs]);

  if (selectedSpec) {
    return (
      <div className="stack">
        <div className="refresh-bar">
          <button className="pagebtn" onClick={() => setSelectedSpec(null)}>All Specs</button>
        </div>
        <SpecDetail specId={selectedSpec} onBack={() => setSelectedSpec(null)} />
      </div>
    );
  }

  const sorted = [...specs].sort((a, b) => {
    const statusA = STATUS_ORDER[a.status] ?? 99;
    const statusB = STATUS_ORDER[b.status] ?? 99;
    if (statusA !== statusB) return statusA - statusB;
    return a.specNum.localeCompare(b.specNum);
  });

  return (
    <div className="stack">
      <div className="refresh-bar">
        <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{specs.length} specs</span>
        <button className="pagebtn" onClick={loadSpecs} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--crit)', color: 'var(--crit)' }}>{error}</div>}
      {!loading && specs.length === 0 && !error && (
        <div className="card"><p className="sub">No specs found. Is the spec-factory path configured?</p></div>
      )}

      {sorted.map((spec) => (
        <SpecCard key={spec.id} spec={spec} onSelect={setSelectedSpec} />
      ))}
    </div>
  );
}
