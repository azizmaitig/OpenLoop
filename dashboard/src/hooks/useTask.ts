import { useQuery } from '@tanstack/react-query';
import { fetchTask } from '../lib/api';
import type { HistoryEntry } from '../lib/types';

export function useTask(id: string | null) {
  return useQuery<HistoryEntry>({
    queryKey: ['task', id],
    queryFn: () => fetchTask(id as string),
    enabled: !!id,
  });
}
