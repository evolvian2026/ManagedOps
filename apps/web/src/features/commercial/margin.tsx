import { useState } from 'react';
import { Badge, Button, Card, Field, PageHeader, Select, Table, Td, Th } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { formatInr } from '../onboarding/format';
import { downloadCsv } from '../exit/api';
import { currentMonth, marginQuery, useMargin, type GroupBy, type MarginRow } from './api';

const GROUPINGS: { value: GroupBy; label: string }[] = [
  { value: 'project', label: 'By project' },
  { value: 'client', label: 'By client' },
  { value: 'trainer', label: 'By trainer' },
];

/**
 * What delivery earned against what it cost.
 *
 * Every grouping is a roll-up of the same per-assignment figures, so switching
 * between them re-cuts one number rather than asking a different question — the
 * totals are identical whichever way you look.
 */
export function MarginPage() {
  const month = currentMonth();
  const [from, setFrom] = useState(month.from);
  const [to, setTo] = useState(month.to);
  const [groupBy, setGroupBy] = useState<GroupBy>('project');

  const filters = { from, to, groupBy };
  const report = useMargin(filters);
  const totals = report.data?.totals;

  return (
    <>
      <PageHeader
        title="Margin"
        description="Revenue billed against salary and expenses, for the period you choose."
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              void downloadCsv(
                `/billing/margin/export.csv?${marginQuery(filters)}`,
                `managedops-margin-${from}-to-${to}.csv`,
              )
            }
          >
            Export CSV
          </Button>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-4">
        <Field
          label="From"
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Field label="To" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        <Select
          label="Group"
          value={groupBy}
          onChange={(event) => setGroupBy(event.target.value as GroupBy)}
        >
          {GROUPINGS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      {totals ? (
        <div className="mb-5 grid gap-4 sm:grid-cols-4">
          <Figure label="Revenue" value={formatInr(totals.revenue)} />
          <Figure label="Cost" value={formatInr(totals.cost)} />
          <Figure
            label="Margin"
            value={formatInr(totals.margin)}
            tone={totals.margin < 0 ? 'critical' : 'positive'}
          />
          <Figure
            label="Margin %"
            value={totals.marginPercent === null ? '—' : `${totals.marginPercent}%`}
            tone={
              totals.marginPercent === null
                ? 'neutral'
                : totals.marginPercent < 0
                  ? 'critical'
                  : 'positive'
            }
          />
        </div>
      ) : null}

      {totals && totals.unbilledAssignments > 0 ? (
        <div className="mb-5 rounded-md border border-accent/30 bg-accent-wash px-3 py-2 text-sm">
          <p className="font-medium text-ink">
            {totals.unbilledAssignments} assignment
            {totals.unbilledAssignments === 1 ? ' has' : 's have'} no agreed rate.
          </p>
          <p className="mt-0.5 text-ink-soft">
            Their cost is counted and their revenue is not, so the margin above is the floor rather
            than the answer. Set a rate on the assignment, or leave it unbilled deliberately.
          </p>
        </div>
      ) : null}

      {report.isPending ? (
        <LoadingState label="Working out the margin" rows={5} />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : report.data.rows.length === 0 ? (
        <EmptyState
          title="Nothing delivered in this period"
          description="No attendance was recorded against any assignment between these dates."
        />
      ) : (
        <Table
          caption="Margin"
          head={
            <>
              <Th>{GROUPINGS.find((option) => option.value === groupBy)?.label.slice(3)}</Th>
              <Th className="text-right">Days billed</Th>
              <Th className="text-right">Revenue</Th>
              <Th className="text-right">Salary</Th>
              <Th className="text-right">Expenses</Th>
              <Th className="text-right">Margin</Th>
            </>
          }
        >
          {report.data.rows.map((row) => (
            <MarginTableRow key={row.key} row={row} />
          ))}
        </Table>
      )}
    </>
  );
}

function MarginTableRow({ row }: { row: MarginRow }) {
  return (
    <tr>
      <Td>
        <div className="font-medium text-ink">{row.label}</div>
        <div className="flex items-center gap-2">
          {row.sublabel ? (
            <span className="font-mono text-xs text-ink-soft">{row.sublabel}</span>
          ) : null}
          {row.unbilled ? <Badge tone="neutral">Unbilled</Badge> : null}
        </div>
      </Td>
      <Td className="text-right tabular-nums text-ink-soft">{row.billableDays}</Td>
      <Td className="text-right tabular-nums">
        {row.unbilled ? (
          <span className="text-xs text-ink-faint">No rate</span>
        ) : (
          formatInr(row.revenue)
        )}
      </Td>
      <Td className="text-right tabular-nums text-ink-soft">{formatInr(row.salaryCost)}</Td>
      <Td className="text-right tabular-nums text-ink-soft">
        {row.reimbursements === 0 ? '—' : formatInr(row.reimbursements)}
      </Td>
      <Td className="text-right tabular-nums">
        <span className={row.margin < 0 ? 'font-medium text-danger' : 'font-medium text-ink'}>
          {formatInr(row.margin)}
        </span>
        {row.marginPercent === null ? null : (
          <div className="text-xs text-ink-soft">{row.marginPercent}%</div>
        )}
      </Td>
    </tr>
  );
}

function Figure({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'positive' | 'critical';
}) {
  const colour =
    tone === 'critical' ? 'text-danger' : tone === 'positive' ? 'text-primary' : 'text-ink';
  return (
    <Card title={label}>
      <p className={`text-2xl font-semibold tabular-nums ${colour}`}>{value}</p>
    </Card>
  );
}
