import { useState } from 'react';
import { Badge, Button, Card, Field, PageHeader, Table, Td, Th } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { formatInr, formatIst, humanise } from '../onboarding/format';
import { downloadCsv } from '../exit/api';
import { lastCompleteMonth, payrollSearch, usePayrollRegister, type PayrollRow } from './api';

/**
 * The month's pay inputs.
 *
 * An input register, not a payslip: it says what ManagedOps knows — days,
 * earnings, claims, settlements — and hands it on. PF, ESI, professional tax
 * and TDS are statutory and belong to whoever files them, so no figure here
 * pretends to be take-home pay.
 *
 * The screen's real job is to refuse to look final while anything is
 * unresolved. A register that reads as settled while a correction is still
 * pending is how somebody quietly gets underpaid.
 */
export function PayrollRegisterPage() {
  const [month, setMonth] = useState(lastCompleteMonth());
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);

  const filters = { month, unresolvedOnly };
  const register = usePayrollRegister(filters);
  const totals = register.data?.totals;

  return (
    <>
      <PageHeader
        title="Payroll Register"
        description="The month’s days and money, in the shape a payroll system wants them."
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              void downloadCsv(
                `/payroll/register/export.csv?${payrollSearch(filters)}`,
                `managedops-payroll-${month}.csv`,
              )
            }
          >
            Export CSV
          </Button>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Field
          label="Month"
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={unresolvedOnly}
            onChange={(event) => setUnresolvedOnly(event.target.checked)}
            className="size-4 rounded border-line"
          />
          <span className="text-ink">Only rows that still need something</span>
        </label>
      </div>

      {totals ? (
        <>
          {totals.unresolved > 0 ? (
            <div className="mb-5 rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm">
              <p className="font-medium text-ink">
                {totals.unresolved} of {totals.people} {totals.people === 1 ? 'row is' : 'rows are'}{' '}
                not ready to pay from.
              </p>
              <p className="mt-0.5 text-ink-soft">
                Each says what is outstanding below. Settle those before exporting, or the figures
                will change after the file leaves here.
              </p>
            </div>
          ) : (
            <div className="mb-5 rounded-md border border-primary/30 bg-primary-wash px-3 py-2 text-sm">
              <p className="font-medium text-primary">
                Every row is accounted for — nothing is awaiting a decision.
              </p>
            </div>
          )}

          <div className="mb-5 grid gap-4 sm:grid-cols-4">
            <Figure label="Earned gross" value={formatInr(totals.earnedGross)} />
            <Figure label="Loss of pay" value={formatInr(totals.lopDeduction)} />
            <Figure label="Reimbursements" value={formatInr(totals.reimbursements)} />
            <Figure label="Total payable" value={formatInr(totals.totalPayable)} strong />
          </div>
        </>
      ) : null}

      {register.isPending ? (
        <LoadingState label="Working out the month" rows={5} />
      ) : register.isError ? (
        <ErrorState error={register.error} onRetry={() => void register.refetch()} />
      ) : register.data.rows.length === 0 ? (
        <EmptyState
          title={unresolvedOnly ? 'Nothing outstanding' : 'Nobody was on the books'}
          description={
            unresolvedOnly
              ? 'Every row for this month is accounted for.'
              : 'No trainer held an assignment during this month.'
          }
        />
      ) : (
        <>
          <Table
            caption={`Payroll register for ${register.data.month}`}
            head={
              <>
                <Th>Person</Th>
                <Th className="text-right">Days paid</Th>
                <Th className="text-right">Unpaid</Th>
                <Th className="text-right">Earned</Th>
                <Th className="text-right">Claims</Th>
                <Th className="text-right">Settlement</Th>
                <Th className="text-right">Total payable</Th>
              </>
            }
          >
            {register.data.rows.map((row) => (
              <RegisterRow key={row.trainerId} row={row} />
            ))}
          </Table>

          <p className="mt-4 text-xs text-ink-faint">
            Worked out {formatIst(register.data.generatedAt)}. These figures are live rather than a
            snapshot: approving a correction changes them. Gross only — statutory deductions are
            applied by your payroll system.
          </p>
        </>
      )}
    </>
  );
}

function RegisterRow({ row }: { row: PayrollRow }) {
  return (
    <>
      <tr>
        <Td>
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{row.name}</span>
            {row.ready ? null : <Badge tone="critical">Not ready</Badge>}
          </div>
          <div className="mt-0.5 font-mono text-xs text-ink-soft">{row.employeeCode}</div>
          {row.status !== 'active' ? (
            <div className="mt-0.5 text-xs text-accent">{humanise(row.status)}</div>
          ) : null}
        </Td>
        <Td className="text-right tabular-nums">
          {row.payableDays}
          <span className="text-xs text-ink-soft"> of {row.workingDaysInMonth}</span>
          {row.leaveDays > 0 ? (
            <div className="text-xs text-ink-soft">{row.leaveDays} on leave</div>
          ) : null}
        </Td>
        <Td className="text-right tabular-nums">
          {row.lopDays === 0 ? (
            <span className="text-ink-faint">—</span>
          ) : (
            <>
              {row.lopDays}
              <div className="text-xs text-danger">−{formatInr(row.lopDeduction)}</div>
            </>
          )}
        </Td>
        <Td className="text-right tabular-nums">
          {formatInr(row.earnedGross)}
          {row.lopDeduction > 0 ? (
            <div className="text-xs text-ink-soft">of {formatInr(row.monthlyGross)}</div>
          ) : null}
        </Td>
        <Td className="text-right tabular-nums text-ink-soft">
          {row.reimbursements === 0 ? '—' : formatInr(row.reimbursements)}
        </Td>
        <Td className="text-right tabular-nums text-ink-soft">
          {row.finalSettlement === 0 ? '—' : formatInr(row.finalSettlement)}
        </Td>
        <Td className="text-right font-medium tabular-nums text-ink">
          {formatInr(row.totalPayable)}
        </Td>
      </tr>
      {row.ready ? null : (
        <tr>
          <td colSpan={7} className="bg-danger-wash/40 px-4 py-2">
            <ul className="space-y-0.5 text-xs text-ink">
              {row.blockers.map((blocker) => (
                <li key={blocker}>• {blocker}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Card title={label}>
      <p className={`text-2xl font-semibold tabular-nums ${strong ? 'text-primary' : 'text-ink'}`}>
        {value}
      </p>
    </Card>
  );
}
