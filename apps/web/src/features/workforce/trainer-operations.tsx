import { useState } from 'react';
import { Badge, Button, Table, Td, Th } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../auth/auth-context';
import { formatDate, formatInr, formatIstTime, humanise } from '../onboarding/format';
import { openResume } from '../onboarding/api';
import { toneFor } from '../operations/punch-card';
import { DeliverableList } from '../operations/my-work';
import { CLAIM_TONE } from '../operations/my-reimbursements';
import { RaiseFlagDialog } from '../operations/flags';
import {
  useAttendanceCalendar,
  useDailyLogs,
  useDeliverables,
  useFlags,
  useLeaveRequests,
  useMyAssets,
  useReimbursements,
  useUnlockDailyLog,
} from '../operations/api';

/**
 * The operational tabs on an administrator's view of one trainer.
 *
 * They read the same endpoints the trainer's own screens do, scoped by the
 * caller's own permissions rather than by which screen they happen to be on —
 * so a project lead sees their team's attendance here and nothing else, without
 * a second set of queries that could drift from the first.
 */

function istMonth(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
}

export function AttendanceTab({ assignmentId }: { assignmentId: string | null }) {
  const [month] = useState(istMonth());
  const calendar = useAttendanceCalendar(month, assignmentId ?? undefined);

  if (!assignmentId) {
    return (
      <EmptyState
        title="No active assignment"
        description="Attendance is recorded against an assignment, and this trainer has none."
      />
    );
  }
  if (calendar.isPending) return <LoadingState label="Loading attendance" rows={5} />;
  if (calendar.isError) {
    return <ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} />;
  }

  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const days = calendar.data.days.filter((day) => day.workDate <= today).reverse();
  const { summary } = calendar.data;

  return (
    <div className="space-y-4">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <Stat label="Present" value={summary.present} />
        <Stat label="Late" value={summary.late} />
        <Stat label="Absent" value={summary.absent} />
        <Stat label="On leave" value={summary.onLeave} />
        <Stat label="Needs attention" value={summary.openIssues} />
      </dl>

      <Table
        caption="This month"
        head={
          <>
            <Th>Date</Th>
            <Th>In</Th>
            <Th>Out</Th>
            <Th>Status</Th>
            <Th>Source</Th>
          </>
        }
      >
        {days.map((day) => (
          <tr key={day.workDate}>
            <Td className="whitespace-nowrap tabular-nums">{formatDate(day.workDate)}</Td>
            <Td className="tabular-nums text-ink-soft">
              {formatIstTime(day.record?.punchInAt ?? null)}
            </Td>
            <Td className="tabular-nums text-ink-soft">
              {formatIstTime(day.record?.punchOutAt ?? null)}
            </Td>
            <Td>
              <Badge tone={toneFor(day.status)}>{humanise(day.status)}</Badge>
            </Td>
            <Td className="text-xs text-ink-faint">
              {day.record ? humanise(day.record.source) : 'Project calendar'}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}

export function DailyLogTab({ trainerId }: { trainerId: string }) {
  const { can } = useAuth();
  const logs = useDailyLogs({ trainerId });
  const unlock = useUnlockDailyLog();
  const [problem, setProblem] = useState<string | null>(null);

  async function open(logId: string) {
    setProblem(null);
    try {
      await unlock.mutateAsync({
        logId,
        reason: 'Unlocked for correction from the trainer profile.',
      });
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  if (logs.isPending) return <LoadingState label="Loading sessions" rows={4} />;
  if (logs.isError) return <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />;
  if (logs.data.data.length === 0) {
    return (
      <EmptyState
        title="No sessions recorded"
        description="Teaching sessions this trainer records appear here."
      />
    );
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
        caption="Recorded sessions"
        head={
          <>
            <Th>Date</Th>
            <Th>Session</Th>
            <Th>Topic</Th>
            <Th>Hours</Th>
            <Th className="text-right">State</Th>
          </>
        }
      >
        {logs.data.data.map((log) => (
          <tr key={log.id}>
            <Td className="whitespace-nowrap tabular-nums">{formatDate(log.workDate)}</Td>
            <Td className="tabular-nums text-ink-soft">#{log.sessionNo}</Td>
            <Td>
              <div className="font-medium text-ink">{log.topic}</div>
              {log.notes ? <div className="text-xs text-ink-soft">{log.notes}</div> : null}
            </Td>
            <Td className="tabular-nums">{Number(log.hours)}</Td>
            <Td className="text-right whitespace-nowrap">
              {log.locked && can('dailylogs.unlock') ? (
                <Button
                  variant="secondary"
                  onClick={() => void open(log.id)}
                  pending={unlock.isPending}
                >
                  Unlock
                </Button>
              ) : (
                <Badge tone={log.locked ? 'neutral' : 'pending'}>
                  {log.locked ? 'Locked' : 'Open'}
                </Badge>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

export function DeliverablesTab({ trainerId }: { trainerId: string }) {
  const { can } = useAuth();
  const deliverables = useDeliverables({ trainerId });

  if (deliverables.isPending) return <LoadingState label="Loading deliverables" rows={4} />;
  if (deliverables.isError) {
    return <ErrorState error={deliverables.error} onRetry={() => void deliverables.refetch()} />;
  }

  const rows = deliverables.data.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing assigned"
        description="Syllabus items and other duties set for this trainer appear here."
      />
    );
  }

  const syllabus = rows.filter((row) => row.type === 'syllabus');
  const duties = rows.filter((row) => row.type === 'other_duty');
  const readOnly = !can('deliverables.write');

  return (
    <div className="space-y-6">
      {syllabus.length > 0 ? (
        <DeliverableList title="Syllabus" rows={syllabus} readOnly={readOnly} />
      ) : null}
      {duties.length > 0 ? (
        <DeliverableList title="Other duties" rows={duties} readOnly={readOnly} />
      ) : null}
    </div>
  );
}

export function LeaveTab({ trainerId }: { trainerId: string }) {
  const leave = useLeaveRequests({ trainerId });

  if (leave.isPending) return <LoadingState label="Loading leave" rows={3} />;
  if (leave.isError) return <ErrorState error={leave.error} onRetry={() => void leave.refetch()} />;
  if (leave.data.data.length === 0) {
    return (
      <EmptyState
        title="No leave requested"
        description="Requests appear here with their outcome."
      />
    );
  }

  return (
    <Table
      caption="Leave requests"
      head={
        <>
          <Th>Dates</Th>
          <Th>Days</Th>
          <Th>Reason</Th>
          <Th>Status</Th>
          <Th>Decided by</Th>
        </>
      }
    >
      {leave.data.data.map((row) => (
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
          <Td className="text-ink-soft">{row.reason}</Td>
          <Td>
            <Badge
              tone={
                row.status === 'approved'
                  ? 'positive'
                  : row.status === 'rejected'
                    ? 'critical'
                    : row.status === 'cancelled'
                      ? 'neutral'
                      : 'pending'
              }
            >
              {humanise(row.status)}
            </Badge>
          </Td>
          <Td className="text-ink-soft">{row.approver?.name ?? '—'}</Td>
        </tr>
      ))}
    </Table>
  );
}

export function ResourcesTab({ assignmentId }: { assignmentId: string | null }) {
  const issues = useMyAssets(assignmentId ?? undefined);

  if (!assignmentId) {
    return (
      <EmptyState
        title="No active assignment"
        description="Assets are issued against an assignment, and this trainer has none."
      />
    );
  }
  if (issues.isPending) return <LoadingState label="Loading issued assets" rows={3} />;
  if (issues.isError)
    return <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />;
  if (issues.data.length === 0) {
    return (
      <EmptyState
        title="Nothing issued"
        description="Hardware and accounts issued to this trainer appear here."
      />
    );
  }

  return (
    <Table
      caption="Issued assets"
      head={
        <>
          <Th>Item</Th>
          <Th>Serial at issue</Th>
          <Th>Issued</Th>
          <Th>Status</Th>
        </>
      }
    >
      {issues.data.map((issue) => (
        <tr key={issue.id}>
          <Td>
            <div className="font-medium text-ink">{issue.asset.name}</div>
            <div className="text-xs text-ink-soft">{humanise(issue.asset.category)}</div>
          </Td>
          <Td className="tabular-nums text-ink-soft">{issue.issueSerial ?? '—'}</Td>
          <Td className="whitespace-nowrap text-ink-soft tabular-nums">
            {formatDate(issue.issuedAt)}
            <div className="text-xs">by {issue.issuedBy.name}</div>
          </Td>
          <Td>
            <Badge
              tone={
                issue.status === 'issued'
                  ? 'positive'
                  : issue.status === 'returned'
                    ? 'neutral'
                    : 'critical'
              }
            >
              {humanise(issue.status)}
            </Badge>
            {issue.returnNotes ? (
              <div className="mt-0.5 text-xs text-ink-soft">{issue.returnNotes}</div>
            ) : null}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

export function ClaimsTab({ trainerId }: { trainerId: string }) {
  const claims = useReimbursements({ trainerId });

  if (claims.isPending) return <LoadingState label="Loading claims" rows={3} />;
  if (claims.isError)
    return <ErrorState error={claims.error} onRetry={() => void claims.refetch()} />;
  if (claims.data.data.length === 0) {
    return (
      <EmptyState title="No claims" description="Expenses this trainer has claimed appear here." />
    );
  }

  return (
    <Table
      caption="Expense claims"
      head={
        <>
          <Th>Submitted</Th>
          <Th>Amount</Th>
          <Th>What for</Th>
          <Th>Status</Th>
          <Th className="text-right">Receipt</Th>
        </>
      }
    >
      {claims.data.data.map((row) => (
        <tr key={row.id}>
          <Td className="whitespace-nowrap tabular-nums">{formatDate(row.createdAt)}</Td>
          <Td className="whitespace-nowrap tabular-nums font-medium">{formatInr(row.amount)}</Td>
          <Td className="text-ink-soft">
            <div>{row.description}</div>
            <div className="text-xs text-ink-faint">{humanise(row.category)}</div>
          </Td>
          <Td>
            <Badge tone={CLAIM_TONE[row.status] ?? 'neutral'}>{humanise(row.status)}</Badge>
          </Td>
          <Td className="text-right">
            <Button variant="secondary" onClick={() => void openResume(row.proofFileId)}>
              View
            </Button>
          </Td>
        </tr>
      ))}
    </Table>
  );
}

export function FlagsTab({
  trainerId,
  assignmentId,
  trainerName,
}: {
  trainerId: string;
  assignmentId: string | null;
  trainerName: string;
}) {
  const { can } = useAuth();
  const flags = useFlags({ trainerId });
  const [raising, setRaising] = useState(false);

  return (
    <div className="space-y-4">
      {can('flags.raise') && assignmentId ? (
        <div className="flex justify-end">
          <Button onClick={() => setRaising(true)}>Raise a concern</Button>
        </div>
      ) : null}

      {flags.isPending ? (
        <LoadingState label="Loading flags" rows={2} />
      ) : flags.isError ? (
        <ErrorState error={flags.error} onRetry={() => void flags.refetch()} />
      ) : flags.data.data.length === 0 ? (
        <EmptyState
          title="No concerns raised"
          description="Flags raised about this trainer, and their outcome, appear here."
        />
      ) : (
        <Table
          caption="Flags"
          head={
            <>
              <Th>Raised</Th>
              <Th>Severity</Th>
              <Th>Concern</Th>
              <Th>Outcome</Th>
            </>
          }
        >
          {flags.data.data.map((row) => (
            <tr key={row.id}>
              <Td className="whitespace-nowrap text-xs text-ink-soft tabular-nums">
                {formatDate(row.createdAt)}
                <div>by {row.raisedBy.name}</div>
              </Td>
              <Td>
                <Badge
                  tone={
                    row.severity === 'high'
                      ? 'critical'
                      : row.severity === 'medium'
                        ? 'pending'
                        : 'neutral'
                  }
                >
                  {humanise(row.severity)}
                </Badge>
              </Td>
              <Td className="text-ink-soft">{row.description}</Td>
              <Td>
                {row.status === 'closed' ? (
                  <>
                    <Badge tone="neutral">{humanise(row.actionTaken ?? 'closed')}</Badge>
                    <div className="mt-0.5 text-xs text-ink-soft">{row.resolutionNote}</div>
                  </>
                ) : (
                  <Badge tone="pending">{humanise(row.status)}</Badge>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {assignmentId ? (
        <RaiseFlagDialog
          assignmentId={assignmentId}
          trainerName={trainerName}
          open={raising}
          onClose={() => setRaising(false)}
        />
      ) : null}
    </div>
  );
}
