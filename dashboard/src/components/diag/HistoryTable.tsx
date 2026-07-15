import { useRef, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  createColumnHelper,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useHistory } from '../../hooks/useHistory';
import { formatDuration, formatTime } from '../../lib/format';
import { Card, Skeleton } from '../ui';
import type { HistoryListEntry } from '../../lib/types';

const PAGE_SIZE = 20;
const ROW_HEIGHT = 38;

const col = createColumnHelper<HistoryListEntry>();
const columns = [
  col.accessor('id', { header: 'ID', size: 120 }),
  col.accessor('command', { header: 'Command' }),
  col.accessor('status', { header: 'Status', size: 110 }),
  col.accessor('createdAt', { header: 'Created', size: 90, cell: (c) => formatTime(c.getValue()) }),
  col.accessor('durationMs', {
    header: 'Duration',
    size: 100,
    cell: (c) => formatDuration(c.getValue() as number | undefined),
  }),
  col.accessor('exitCode', { header: 'Exit', size: 70 }),
];

export function HistoryTable({ onSelect }: { onSelect: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const { data, isPending } = useHistory(page, PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);

  const table = useReactTable({
    data: data?.tasks ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const rows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    useFlushSync: false,
  });

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card title="Task History">
      {isPending ? (
        <Skeleton height={200} />
      ) : (
        <>
          <div ref={scrollRef} className="feed-scroll" style={{ height: 460 }}>
            <table className="dt">
              <thead>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <th key={h.id} style={{ width: h.getSize() }}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length} className="muted">
                      no history yet
                    </td>
                  </tr>
                ) : (
                  <tr style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                    <td style={{ padding: 0, border: 0 }} colSpan={columns.length}>
                      <div style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
                        {virtualizer.getVirtualItems().map((vi) => {
                          const row = rows[vi.index];
                          return (
                            <tr
                              key={row.id}
                              onClick={() => onSelect(row.original.id)}
                              style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: ROW_HEIGHT,
                                transform: `translateY(${vi.start}px)`,
                                display: 'table',
                                tableLayout: 'fixed',
                              }}
                            >
                              {row.getVisibleCells().map((cell) => (
                                <td key={cell.id} style={{ width: cell.column.getSize() }}>
                                  {flexRender(
                                    cell.column.columnDef.cell ?? ((c) => String(c.getValue())),
                                    cell.getContext(),
                                  )}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
            <span className="muted">
              {total} tasks · page {page}/{pageCount}
            </span>
            <div className="row" style={{ gap: 6 }}>
              <button className="pagebtn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                prev
              </button>
              <button className="pagebtn" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
                next
              </button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
