import type { ReactNode } from 'react';

export function Card({
  title,
  children,
  className,
  right,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div className={`card ${className ?? ''}`}>
      {title && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>{title}</h3>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Skeleton({ height = 14 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} />;
}

export function StatusDot({ status }: { status: 'ok' | 'warn' | 'crit' | 'dim' }) {
  return <span className={`dot ${status}`} />;
}

export function Pill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'crit' | 'dim';
  children: ReactNode;
}) {
  const color =
    tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'crit' ? 'var(--crit)' : 'var(--text-dim)';
  return (
    <span className="pill" style={{ color, background: 'color-mix(in srgb, ' + color + ' 18%, transparent)' }}>
      <StatusDot status={tone} />
      {children}
    </span>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 style={{ fontSize: 16, margin: '4px 0 12px' }}>{children}</h2>;
}
