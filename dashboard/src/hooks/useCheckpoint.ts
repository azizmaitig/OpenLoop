import { useQuery } from '@tanstack/react-query';
import { fetchCheckpoint } from '../lib/api';
import type { CheckpointState } from '../lib/types';

export function useCheckpoint(planPath?: string) {
  return useQuery<CheckpointState | null>({
    queryKey: ['checkpoint', planPath ?? ''],
    queryFn: ({ signal }) => fetchCheckpoint(planPath, signal),
  });
}
