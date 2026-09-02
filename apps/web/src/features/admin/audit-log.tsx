import { useState } from 'react';
import { Badge, Button, Field, PageHeader, Table, Td, Th } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { formatIst, humanise } from '../onboarding/format';
import { downloadCsv } from '../exit/api';
import { useAuditLog, type AuditEntry, type AuditFilters } from './api';

/**
 * Every mutation, who made it and what it looked like.
 *
 * A row expands into the payload rather than a diff of two JSON blobs: the
 * interceptor records what the request asked for, which is the thing somebody
 * investigating actually wants to read. Pretending to show a before-and-after
 * we never captured would be worse than showing the request honestly.
 */
export function AuditLogPage() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const audit = useAuditLog(filters, page);

  function update(patch: AuditFilters) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }

  const exportQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) exportQuery.set(key, value);
  }

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Every change, who made it, and from where."
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              void downloadCsv(
                `/audit-logs/export.csv${exportQuery.toString() ? `?${exportQuery}` : ''}`,
                'managedops-audit.csv',
              )
            }
          >
            Export CSV
          </Button>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-4">
        <Field
          label="Entity"
          placeholder="Trainer, LeaveRequest…"
          value={filters.entityType ?? ''}
          onChange={(event) => update({ entityType: event.target.value })}
        />
        <Field
          label="Action contains"
          placeholder="POST /api/v1/leave"
          value={filters.action ?? ''}
          onChange={(event) => update({ action: event.target.value })}
        />
        <Field
          label="From"
          type="date"
          value={filters.from ?? ''}
          onChange={(event) => update({ from: event.target.value })}
        />
        <Field
          label="To"
          type="date"
          value={filters.to ?? ''}
          onChange={(event) => update({ to: event.target.value })}
        />
      </div>

      {audit.isPending ? (
        <LoadingState label="Loading the audit trail" rows={6} />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : audit.data.data.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="Every mutation is recorded; widen the filters to find it."
        />
      ) : (
        <>
          <Table
            caption="Audit entries"
            head={
              <>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Action</Th>
                <Th>Entity</Th>
                <Th className="text-right">Detail</Th>
              </>
            }
          >
            {audit.data.data.map((entry) => (
              <AuditRow
                key={entry.id}
                entry={entry}
                expanded={expanded === entry.id}
                onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
              />
            ))}
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-ink-soft tabular-nums">
              Page {audit.data.meta.page} of {audit.data.meta.totalPages} · {audit.data.meta.total}{' '}
              entries
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                ← Newer
              </Button>
              <Button
                variant="secondary"
                disabled={page >= audit.data.meta.totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Older →
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function AuditRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <Td className="whitespace-nowrap tabular-nums text-ink-soft">
          {formatIst(entry.createdAt)}
        </Td>
        <Td>
          {entry.actor ? (
            <>
              <div className="font-medium text-ink">{entry.actor.name}</div>
              <div className="text-xs text-ink-soft">{humanise(entry.actor.role)}</div>
            </>
          ) : (
            <span className="text-xs text-ink-faint">system</span>
          )}
        </Td>
        <Td className="font-mono text-xs text-ink">{entry.action}</Td>
        <Td>
          <Badge tone="neutral">{entry.entityType}</Badge>
        </Td>
        <Td className="text-right">
          <Button variant="secondary" onClick={onToggle}>
            {expanded ? 'Hide' : 'Show'}
          </Button>
        </Td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={5} className="bg-surface-sunk px-4 py-3">
            <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-ink-soft">Entity id</dt>
              <dd className="font-mono text-ink">{entry.entityId ?? '—'}</dd>
              <dt className="text-ink-soft">Request</dt>
              <dd className="font-mono text-ink">{entry.requestId ?? '—'}</dd>
              <dt className="text-ink-soft">From</dt>
              <dd className="font-mono text-ink">{entry.ip ?? '—'}</dd>
            </dl>
            {/* Credentials never reach the trail; the interceptor redacts them
                before the row is written, not on the way out. */}
            <pre className="max-h-64 overflow-auto rounded-md border border-line bg-surface p-3 text-xs text-ink">
              {JSON.stringify(entry.after ?? entry.before ?? {}, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}
