import { useQuery } from '@tanstack/react-query';
import { fetchHistory } from '../lib/api';
import type { HistoryListResponse } from '../lib/types';

export function useHistory(page: number, pageSize: number) {
  return useQuery<HistoryListResponse>({
    queryKey: ['history', page, pageSize],
    queryFn: () => fetchHistory(page, pageSize),
    placeholderData: (prev) => prev,
  });
}
