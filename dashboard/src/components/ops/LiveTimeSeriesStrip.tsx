import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import UplotReact from 'uplot-react';
import { useTimeSeries } from '../../hooks/useTimeSeries';
import type { TimeSeriesPoint } from '../../lib/types';
import { Card, Skeleton } from '../ui';
import { DEFAULT_WINDOW } from '../../lib/constants';

const COLORS: Record<string, string> = {
  throughput: '#58a6ff',
  durationP95: '#3fb950',
  passRate: '#d29922',
};

export function UPlotChart({
  points,
  metric,
  height = 150,
}: {
  points: TimeSeriesPoint[];
  metric: string;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setWidth(Math.max(160, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const xs = points.map((p) => p.t / 1000); // uPlot time scale is seconds
  const ys = points.map((p) => p.v);
  const data: uPlot.AlignedData = [xs, ys];

  const opts: uPlot.Options = {
    width,
    height,
    scales: { x: { time: true } },
    legend: { show: false },
    cursor: { points: { show: false } },
    axes: [
      {
        stroke: '#8b98a5',
        grid: { stroke: '#2a3340' },
        ticks: { stroke: '#2a3340' },
      },
      {
        stroke: '#8b98a5',
        grid: { stroke: '#2a3340' },
        ticks: { stroke: '#2a3340' },
      },
    ],
    series: [
      {},
      {
        label: metric,
        stroke: COLORS[metric] ?? '#58a6ff',
        width: 2,
        points: { show: false },
      },
    ],
  };

  return (
    <div ref={ref} className="uplot">
      <UplotReact options={opts} data={data} />
    </div>
  );
}

function MetricChart({ metric, label, window }: { metric: string; label: string; window: string }) {
  const { data, isPending } = useTimeSeries(metric, window);

  return (
    <Card title={label}>
      {isPending ? (
        <Skeleton height={150} />
      ) : !data || data.points.length === 0 ? (
        <div className="muted">no series data</div>
      ) : (
        <UPlotChart points={data.points} metric={metric} />
      )}
    </Card>
  );
}

export function LiveTimeSeriesStrip({ window = DEFAULT_WINDOW }: { window?: string }) {
  return (
    <div className="grid grid-2">
      <MetricChart metric="throughput" label="Throughput (tasks/min)" window={window} />
      <MetricChart metric="durationP95" label="Duration p95 (ms)" window={window} />
    </div>
  );
}
