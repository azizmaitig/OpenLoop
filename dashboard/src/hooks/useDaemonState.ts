import { useQuery } from '@tanstack/react-query';
import { fetchDaemonState } from '../lib/api';
import { useStreamTransport } from './useLoopStream';
import type { DaemonState } from '../lib/types';

export function useDaemonState() {
  const transport = useStreamTransport();
  return useQuery<DaemonState>({
    queryKey: ['state'],
    queryFn: fetchDaemonState,
    refetchInterval: transport === 'poll' ? 3000 : false,
    staleTime: 2000,
  });
}
