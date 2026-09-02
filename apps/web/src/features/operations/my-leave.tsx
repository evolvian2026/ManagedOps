import { useState } from 'react';
import type { LeaveDayType } from '@managedops/shared';
import {
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  TextArea,
} from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { ApiError, errorMessage } from '../../lib/api';
import { formatDate, humanise } from '../onboarding/format';
import {
  useCancelLeave,
  useLeaveBalance,
  useLeaveRequests,
  useRequestLeave,
  type LeaveRow,
} from './api';

const LEAVE_TONE: Record<string, 'neutral' | 'positive' | 'pending' | 'critical'> = {
  submitted: 'pending',
  escalated: 'pending',
  approved: 'positive',
  rejected: 'critical',
  cancelled: 'neutral',
};

function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * The trainer's leave screen: what is left, how to ask for more, and where each
 * request stands.
 *
 * A request over the balance is not blocked here — the form shows the overage
 * and says it would be unpaid, and the approver decides. Blocking it in the
 * browser would only teach people to ask their lead over WhatsApp instead.
 */
export function MyLeavePage() {
  const balance = useLeaveBalance();
  const requests = useLeaveRequests({ mine: true });

  return (
    <>
      <PageHeader
        title="My Leave"
        description="Your allowance for this assignment, and every request you have made."
      />

      <div className="space-y-6">
        {balance.isPending ? (
          <LoadingState label="Loading your balance" rows={1} />
        ) : balance.isError ? (
          <ErrorState error={balance.error} onRetry={() => void balance.refetch()} />
        ) : (
          <BalanceCard
            allowance={balance.data.allowance}
            used={balance.data.used}
            remaining={balance.data.remaining}
            projectName={balance.data.assignment.project.name}
          />
        )}

        <RequestForm remaining={balance.data?.remaining ?? 0} />

        {requests.isPending ? (
          <LoadingState label="Loading your requests" rows={3} />
        ) : requests.isError ? (
          <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
        ) : requests.data.data.length === 0 ? (
          <EmptyState
            title="No leave requested yet"
            description="Requests you make appear here with their current status."
          />
        ) : (
          <RequestTable rows={requests.data.data} />
        )}
      </div>
    </>
  );
}

function BalanceCard({
  allowance,
  used,
  remaining,
  projectName,
}: {
  allowance: number;
  used: number;
  remaining: number;
  projectName: string;
}) {
  return (
    <Card title="Your balance" description={projectName}>
      <div className="flex flex-wrap items-end gap-8">
        <div>
          <p className="text-3xl font-semibold tabular-nums text-ink">{remaining}</p>
          <p className="text-sm text-ink-soft">days remaining</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <dt className="text-ink-soft">Allowance</dt>
          <dd className="tabular-nums text-ink">{allowance} days</dd>
          <dt className="text-ink-soft">Used</dt>
          <dd className="tabular-nums text-ink">{used} days</dd>
        </dl>
      </div>
      {/* Spec assumption A5 — the balance belongs to the assignment, not the person. */}
      <p className="mt-4 text-xs text-ink-faint">
        The allowance is per assignment and does not carry over between projects. Weekends and
        project holidays inside a leave range do not consume it.
      </p>
    </Card>
  );
}

function RequestForm({ remaining }: { remaining: number }) {
  const [startDate, setStartDate] = useState(istToday());
  const [endDate, setEndDate] = useState(istToday());
  const [dayType, setDayType] = useState<LeaveDayType>('full');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const request = useRequestLeave();

  // A rough count for the warning below; the server does the real arithmetic
  // with the project's own holidays and weekly offs.
  const spanDays =
    dayType === 'half'
      ? 0.5
      : Math.max(
          0,
          Math.round(
            (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
              86_400_000,
          ) + 1,
        );

  async function submit() {
    setProblem(null);
    setFieldErrors({});
    try {
      await request.mutateAsync({
        startDate,
        endDate: dayType === 'half' ? startDate : endDate,
        dayType,
        reason: reason.trim(),
      });
      setReason('');
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Card
      title="Request leave"
      description="Your project lead decides; after 24 hours it escalates."
    >
      <div className="space-y-4">
        {problem ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
          >
            {problem}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="From"
            type="date"
            value={startDate}
            error={fieldErrors.startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
              if (event.target.value > endDate) setEndDate(event.target.value);
            }}
          />
          <Field
            label="To"
            type="date"
            min={startDate}
            value={dayType === 'half' ? startDate : endDate}
            disabled={dayType === 'half'}
            error={fieldErrors.endDate}
            hint={dayType === 'half' ? 'A half day is a single date' : undefined}
            onChange={(event) => setEndDate(event.target.value)}
          />
          <Select
            label="Type"
            value={dayType}
            error={fieldErrors.dayType}
            onChange={(event) => setDayType(event.target.value as LeaveDayType)}
          >
            <option value="full">Full day(s)</option>
            <option value="half">Half day</option>
          </Select>
        </div>

        <TextArea
          label="Reason"
          rows={2}
          required
          value={reason}
          error={fieldErrors.reason}
          onChange={(event) => setReason(event.target.value)}
        />

        {spanDays > remaining ? (
          <p className="rounded-md border border-accent/30 bg-accent-wash px-3 py-2 text-sm text-ink">
            That is about {spanDays} day(s) against {remaining} remaining. You can still ask — your
            approver sees the overage, and anything beyond the balance is recorded as leave without
            pay.
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button
            onClick={() => void submit()}
            pending={request.isPending}
            disabled={reason.trim().length < 5}
          >
            Send request
          </Button>
        </div>
      </div>
    </Card>
  );
}

function RequestTable({ rows }: { rows: LeaveRow[] }) {
  const cancel = useCancelLeave();
  const [problem, setProblem] = useState<string | null>(null);
  const today = istToday();

  async function withdraw(id: string) {
    setProblem(null);
    try {
      await cancel.mutateAsync(id);
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <div className="space-y-2">
      {problem ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
        >
          {problem}
        </div>
      ) : null}

      <Table
        caption="Your leave requests"
        head={
          <>
            <Th>Dates</Th>
            <Th>Days</Th>
            <Th>Reason</Th>
            <Th>Status</Th>
            <Th className="text-right">Action</Th>
          </>
        }
      >
        {rows.map((row) => (
          <tr key={row.id}>
            <Td className="whitespace-nowrap tabular-nums">
              {formatDate(row.startDate)}
              {row.endDate !== row.startDate ? ` – ${formatDate(row.endDate)}` : ''}
            </Td>
            <Td className="tabular-nums">
              {Number(row.daysCount)}
              {Number(row.unpaidDays) > 0 ? (
                <span className="ml-1 text-xs text-danger">({Number(row.unpaidDays)} unpaid)</span>
              ) : null}
            </Td>
            <Td className="text-ink-soft">
              <div>{row.reason}</div>
              {row.decisionNote ? (
                <div className="text-xs text-ink-faint">{row.decisionNote}</div>
              ) : null}
            </Td>
            <Td>
              <Badge tone={LEAVE_TONE[row.status] ?? 'neutral'}>{humanise(row.status)}</Badge>
              {row.approver ? (
                <div className="mt-0.5 text-xs text-ink-soft">by {row.approver.name}</div>
              ) : null}
            </Td>
            <Td className="text-right">
              {['submitted', 'escalated', 'approved'].includes(row.status) &&
              row.startDate.slice(0, 10) > today ? (
                <Button
                  variant="secondary"
                  onClick={() => void withdraw(row.id)}
                  pending={cancel.isPending}
                >
                  Withdraw
                </Button>
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
