import { describe, it, expect } from 'bun:test';
import {
  createTsRing,
  finalizeHealthScore,
  handleDashboardApi,
  type TsRing,
} from '../src/dashboard-api';

describe('createTsRing', () => {
  it('appends and reads points within the window', () => {
    const ring = createTsRing(10);
    const now = Date.now();
    ring.append({ metric: 'throughput', t: now, v: 3 });
    ring.append({ metric: 'throughput', t: now - 1000, v: 2 });
    const res = ring.read('throughput', '1h');
    expect(res.metric).toBe('throughput');
    expect(res.points.length).toBe(2);
  });

  it('evicts beyond capacity (FIFO)', () => {
    const ring = createTsRing(3);
    const now = Date.now();
    for (let i = 0; i < 5; i++) ring.append({ metric: 'm', t: now - (5 - i) * 1000, v: i });
    const res = ring.read('m', '24h');
    expect(res.points.length).toBe(3);
    expect(res.points[0].v).toBe(2);
  });
});

describe('finalizeHealthScore', () => {
  it('grades by score thresholds', () => {
    expect(
      finalizeHealthScore(1, 0, 1, 1, '1h', 100).grade,
    ).toBe('healthy');
    expect(
      finalizeHealthScore(0.6, 0.1, 0.6, 0.6, '1h', 100).grade,
    ).toBe('degraded');
    expect(
      finalizeHealthScore(0.1, 0.9, 0.1, 0.1, '1h', 100).grade,
    ).toBe('critical');
  });

  it('returns a 0-100 score', () => {
    const s = finalizeHealthScore(1, 0, 1, 1, '1h', 100);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });
});

function fakeApi(): any {
  return {
    baseDir: '.',
    getState: () => ({ queueLength: 0, currentTask: null }),
    listTaskHistory: async () => ({ tasks: [], total: 0, page: 1, pageSize: 1 }),
    tsRing: createTsRing(10) as TsRing,
  };
}

describe('handleDashboardApi', () => {
  it('returns null for unrelated routes', async () => {
    const req = new Request('http://x/state');
    const res = await handleDashboardApi(fakeApi(), new URL(req.url), req, fakeApi().tsRing);
    expect(res).toBeNull();
  });

  it('serves /api/health-score with a JSON score', async () => {
    const req = new Request('http://x/api/health-score?window=1h&lastN=100');
    const res = await handleDashboardApi(fakeApi(), new URL(req.url), req, fakeApi().tsRing);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(typeof body.score).toBe('number');
    expect(['healthy', 'degraded', 'critical']).toContain(body.grade);
  });

  it('serves /api/checkpoint (404 when absent, else a CheckpointState)', async () => {
    const req = new Request('http://x/api/checkpoint');
    const res = await handleDashboardApi(fakeApi(), new URL(req.url), req, fakeApi().tsRing);
    expect(res).not.toBeNull();
    if (res!.status === 404) {
      expect((await res!.json()).error).toBe('no checkpoint');
    } else {
      expect(res!.status).toBe(200);
      expect(typeof (await res!.json()).planName).toBe('string');
    }
  });

  it('serves /api/metrics/timeseries (empty when no history)', async () => {
    const req = new Request('http://x/api/metrics/timeseries?metric=throughput&window=1h');
    const res = await handleDashboardApi(fakeApi(), new URL(req.url), req, fakeApi().tsRing);
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.metric).toBe('throughput');
    expect(Array.isArray(body.points)).toBe(true);
  });
});
