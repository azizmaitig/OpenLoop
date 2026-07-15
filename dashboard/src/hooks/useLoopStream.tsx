// hooks/useLoopStream.ts — single transport seam (design §0 principle 2).
// Owns the WebSocket, buffers messages in a ref, and drains them once per
// animation frame (RAF batching, §0 principle 3). Live events also prime the
// TanStack Query cache so the REST layer and WS layer share one source of truth
// (§0 principle 4). Degrades to a poll flag if WS repeatedly fails (§0 principle 5).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  DaemonState,
  ChildLoopSummary,
  StreamEvent,
  StreamStoreTransport,
} from '../lib/types';
import { createRafScheduler } from '../lib/raf';

export interface StreamStore {
  state: DaemonState | null;
  loops: ChildLoopSummary[] | null;
  events: StreamEvent[];
  transport: StreamStoreTransport;
  connected: boolean;
  lastEventAt: number;
  /** Monotonic total event counter (never reset, unlike the capped events[]). */
  totalEvents: number;
}

/**
 * Assign monotonic sequence numbers to a batch of events.
 * Called inside flush() BEFORE the EVENT_CAP so seq always increases.
 * Exported for testing.
 */
export function assignSeq(events: StreamEvent[], counter: { current: number }): void {
  for (let i = 0; i < events.length; i++) {
    events[i].seq = counter.current++;
  }
}

const EVENT_CAP = 500;
const MAX_BACKOFF_MS = 15000;
const POLL_FALLBACK_ATTEMPTS = 5;

const initialStore: StreamStore = {
  state: null,
  loops: null,
  events: [],
  totalEvents: 0,
  transport: 'ws',
  connected: false,
  lastEventAt: 0,
};

interface StreamContextValue {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => StreamStore;
  transport: StreamStoreTransport;
}

const StreamContext = createContext<StreamContextValue | null>(null);

export function LoopStreamProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const storeRef = useRef<StreamStore>(initialStore);
  const listeners = useRef(new Set<() => void>());
  const bufferRef = useRef<StreamEvent[]>([]);
  const raf = useRef(createRafScheduler());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef(0);
  const lastFlushRef = useRef(0);
  const seqRef = useRef(0);

  const emit = useCallback(() => {
    listeners.current.forEach((cb) => cb());
  }, []);

  const commit = useCallback((next: StreamStore) => {
    storeRef.current = next;
    emit();
  }, [emit]);

  // Apply buffered events to the store once per frame.
  const flush = useCallback(() => {
    const buffered = bufferRef.current;
    if (buffered.length === 0) return;
    bufferRef.current = [];

    // Assign monotonic seq numbers BEFORE capping (seq grows unbounded).
    assignSeq(buffered, seqRef);

    const next: StreamStore = { ...storeRef.current };
    let changed = false;

    for (const ev of buffered) {
      switch (ev.type) {
        case 'state_change': {
          const d = ev.data as DaemonState & { children?: ChildLoopSummary[] };
          next.state = d as DaemonState;
          if (Array.isArray(d.children)) {
            next.loops = d.children;
            queryClient.setQueryData(['loops'], d.children);
          }
          queryClient.setQueryData(['state'], d as DaemonState);
          changed = true;
          break;
        }
        case 'child_status_change': {
          const d = ev.data as ChildLoopSummary[];
          if (Array.isArray(d)) {
            next.loops = d;
            queryClient.setQueryData(['loops'], d);
          }
          changed = true;
          break;
        }
        case 'task_completed':
        // DAG event types — store so the Graph tab can reconstruct the DAG
        case 'phase_start':
        case 'phase_complete':
        case 'task_started':
        case 'task_failed':
        case 'fsm_transition':
        case 'iteration_start':
        case 'iteration_complete': {
          queryClient.invalidateQueries({ queryKey: ['history'] });
          changed = true;
          break;
        }
        default:
          break;
      }
    }

    if (changed || buffered.length > 0) {
      // Prepend newest events first; cap the ring (design §2.3).
      const merged = [...buffered.slice().reverse(), ...next.events].slice(0, EVENT_CAP);
      next.events = merged;
      next.totalEvents = storeRef.current.totalEvents + buffered.length;
      next.lastEventAt = Date.now();
      commit(next);
    }
  }, [commit, queryClient]);

  const scheduleFlush = useCallback(() => {
    raf.current.schedule();
  }, []);

  // Keep flush registered with the scheduler.
  useEffect(() => {
    raf.current.setFlush(flush);
    return () => raf.current.stop();
  }, [flush]);

  // Backgrounded-tab safety net: if RAF is paused (hidden tab) or the frame is
  // starved, drain on a slow interval too (design §2.3 second gate).
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      if (bufferRef.current.length > 0 && now - lastFlushRef.current > 200) {
        lastFlushRef.current = now;
        flush();
      }
    }, 250);
    return () => clearInterval(id);
  }, [flush]);

  // WebSocket lifecycle with exponential backoff + poll fallback.
  useEffect(() => {
    let closedByUs = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${proto}://${location.host}/ws`);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectRef.current = 0;
        commit({ ...storeRef.current, connected: true, transport: 'ws' });
      };

      ws.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(msg.data as string) as StreamEvent;
          if (parsed && typeof parsed.type === 'string') {
            bufferRef.current.push(parsed);
            scheduleFlush();
          }
        } catch {
          /* ignore malformed frames defensively */
        }
      };

      ws.onclose = () => {
        commit({ ...storeRef.current, connected: false });
        scheduleReconnect();
      };

      ws.onerror = () => {
        try { ws.close(); } catch { /* noop */ }
      };
    };

    const scheduleReconnect = () => {
      if (closedByUs) return;
      reconnectRef.current += 1;
      // After enough failures, flip to poll so the REST layer takes over.
      if (reconnectRef.current >= POLL_FALLBACK_ATTEMPTS) {
        commit({ ...storeRef.current, transport: 'poll', connected: false });
      }
      const delay = Math.min(1000 * 2 ** (reconnectRef.current - 1), MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { wsRef.current?.close(); } catch { /* noop */ }
    };
  }, [commit, scheduleFlush]);

  const subscribe = useCallback((cb: () => void) => {
    listeners.current.add(cb);
    return () => {
      listeners.current.delete(cb);
    };
  }, []);

  const getSnapshot = useCallback(() => storeRef.current, []);

  const transport = storeRef.current.transport;

  const ctx = useMemo<StreamContextValue>(
    () => ({ subscribe, getSnapshot, transport }),
    [subscribe, getSnapshot, transport],
  );

  return <StreamContext.Provider value={ctx}>{children}</StreamContext.Provider>;
}

function useStreamContext(): StreamContextValue {
  const ctx = useContext(StreamContext);
  if (!ctx) {
    throw new Error('useLoopStream must be used within <LoopStreamProvider>');
  }
  return ctx;
}

export function useStreamStore(): StreamStore {
  const { subscribe, getSnapshot } = useStreamContext();
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useStreamTransport(): StreamStoreTransport {
  return useStreamStore().transport;
}

export function useEventFeed(): StreamEvent[] {
  return useStreamStore().events;
}
