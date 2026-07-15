import { useQuery } from '@tanstack/react-query';
import { fetchTimeSeries } from '../lib/api';
import type { TimeSeriesResponse } from '../lib/types';
import { DEFAULT_WINDOW, type Metric } from '../lib/constants';

export function useTimeSeries(metric: Metric, window: string = DEFAULT_WINDOW) {
  return useQuery<TimeSeriesResponse | null>({
    queryKey: ['timeseries', metric, window],
    queryFn: () => fetchTimeSeries(metric, window),
    refetchInterval: 5000,
  });
}
