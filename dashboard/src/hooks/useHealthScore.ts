import { useQuery } from '@tanstack/react-query';
import { fetchHealthScore } from '../lib/api';
import type { HealthScore } from '../lib/types';
import { DEFAULT_WINDOW } from '../lib/constants';

export function useHealthScore(window: string = DEFAULT_WINDOW, lastN: number = 100) {
  return useQuery<HealthScore | null>({
    queryKey: ['health', window, lastN],
    queryFn: ({ signal }) => fetchHealthScore(window, lastN, signal),
    refetchInterval: 5000,
  });
}
