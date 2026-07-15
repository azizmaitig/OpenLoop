import { describe, it, expect } from 'vitest';
import { formatDuration, formatPercent, formatUptime } from './format';

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65000)).toBe('1m 5s');
  });

  it('formats percents', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0.42, 0)).toBe('42%');
    expect(formatPercent(0.425, 1)).toBe('42.5%');
  });

  it('formats uptime', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(3661)).toBe('1h 1m');
  });
});
