import { useQuery } from '@tanstack/react-query';
import { fetchMetrics } from '../lib/api';
import type { MetricsResponse } from '../lib/types';
import { DEFAULT_WINDOW } from '../lib/constants';

export function useMetrics(window: string = DEFAULT_WINDOW, lastN: number = 100) {
  return useQuery<MetricsResponse>({
    queryKey: ['metrics', window, lastN],
    queryFn: ({ signal }) => fetchMetrics(window, lastN, signal),
    refetchInterval: 5000,
    staleTime: 2000,
  });
}
