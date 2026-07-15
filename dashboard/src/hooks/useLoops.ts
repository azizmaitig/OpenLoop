import { useQuery } from '@tanstack/react-query';
import { fetchLoops } from '../lib/api';
import { useStreamTransport } from './useLoopStream';
import type { ChildLoopSummary } from '../lib/types';

export function useLoops() {
  const transport = useStreamTransport();
  return useQuery<ChildLoopSummary[]>({
    queryKey: ['loops'],
    queryFn: ({ signal }) => fetchLoops(signal),
    refetchInterval: transport === 'poll' ? 3000 : false,
    staleTime: 2000,
  });
}
