export type ScreenId = 'ops' | 'diag' | 'dag' | 'specs' | 'orchestration' | 'evolve';

export function TabNav({
  active,
  onChange,
}: {
  active: ScreenId;
  onChange: (id: ScreenId) => void;
}) {
  return (
    <nav className="tabnav">
      <button className={active === 'ops' ? 'active' : ''} onClick={() => onChange('ops')}>
        Ops Health
      </button>
      <button className={active === 'diag' ? 'active' : ''} onClick={() => onChange('diag')}>
        Diagnostic
      </button>
      <button className={active === 'dag' ? 'active' : ''} onClick={() => onChange('dag')}>
        Graph
      </button>
      <button className={active === 'specs' ? 'active' : ''} onClick={() => onChange('specs')}>
        Specs
      </button>
      <button className={active === 'orchestration' ? 'active' : ''} onClick={() => onChange('orchestration')}>
        Orchestration
      </button>
      <button className={active === 'evolve' ? 'active' : ''} onClick={() => onChange('evolve')}>
        Evolve
      </button>
    </nav>
  );
}
