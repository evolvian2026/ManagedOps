import { useState } from 'react';
import { REIMBURSEMENT_HR_LIMIT } from '@managedops/shared';
import {
  Badge,
  Button,
  Field,
  Modal,
  PageHeader,
  Table,
  Tabs,
  Td,
  Th,
  TextArea,
} from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../auth/auth-context';
import { formatDate, formatInr, formatIstTime, humanise } from '../onboarding/format';
import { openResume } from '../onboarding/api';
import { CLAIM_TONE } from './my-reimbursements';
import {
  useCorrections,
  useDecideClaim,
  useDecideCorrection,
  useDecideLeave,
  useLeaveRequests,
  useMarkClaimPaid,
  useReimbursements,
} from './api';

type Tab = 'corrections' | 'leave' | 'claims';

/**
 * One queue for everything waiting on this person.
 *
 * Corrections, leave and claims are three different records, but to an approver
 * they are one job — the things nobody else can move forward. Three sidebar
 * entries would mean checking three screens to find out whether there is
 * anything to do.
 */
export function ApprovalsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('corrections');

  const corrections = useCorrections('pending');
  const leave = useLeaveRequests({ pending: true });
  const claims = useReimbursements({ status: 'submitted' });

  const tabs = [
    ...(can('attendance.corrections.approve')
      ? [
          {
            id: 'corrections' as const,
            label: 'Attendance',
            count: corrections.data?.meta.total,
          },
        ]
      : []),
    ...(can('leave.approve')
      ? [{ id: 'leave' as const, label: 'Leave', count: leave.data?.meta.total }]
      : []),
    ...(can('reimbursements.approve')
      ? [{ id: 'claims' as const, label: 'Claims', count: claims.data?.meta.total }]
      : []),
  ];

  // A lead holds only some of these; landing them on an empty tab they cannot
  // use would be a worse first impression than showing what they can act on.
  const active = tabs.some((entry) => entry.id === tab) ? tab : (tabs[0]?.id ?? 'corrections');

  return (
    <>
      <PageHeader title="Approvals" description="Everything waiting on a decision from you." />

      {tabs.length === 0 ? (
        <EmptyState
          title="Nothing routed to you"
          description="Your role does not approve attendance corrections, leave or claims."
        />
      ) : (
        <>
          <Tabs label="Approval queues" active={active} onChange={setTab} tabs={tabs} />
          <div className="mt-6">
            {active === 'corrections' ? <CorrectionsQueue query={corrections} /> : null}
            {active === 'leave' ? <LeaveQueue query={leave} /> : null}
            {active === 'claims' ? <ClaimsQueue query={claims} /> : null}
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------- corrections */

type Query<T> = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data?: { data: T[]; meta: { total: number } };
  refetch: () => unknown;
};

function QueueState<T>({
  query,
  emptyTitle,
  emptyDescription,
  children,
}: {
  query: Query<T>;
  emptyTitle: string;
  emptyDescription: string;
  children: (rows: T[]) => React.ReactNode;
}) {
  if (query.isPending) return <LoadingState label="Loading the queue" rows={3} />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  const rows = query.data?.data ?? [];
  if (rows.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return <>{children(rows)}</>;
}

function CorrectionsQueue({ query }: { query: ReturnType<typeof useCorrections> }) {
  const decide = useDecideCorrection();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function approve(correctionId: string) {
    setProblem(null);
    try {
      await decide.mutateAsync({ correctionId, decision: 'approved' });
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

      <QueueState
        query={query}
        emptyTitle="No corrections waiting"
        emptyDescription="Attendance corrections raised by your trainers appear here."
      >
        {(rows) => (
          <Table
            caption="Attendance corrections awaiting a decision"
            head={
              <>
                <Th>Trainer</Th>
                <Th>Day</Th>
                <Th>Recorded</Th>
                <Th>Requested</Th>
                <Th>Reason</Th>
                <Th className="text-right">Decision</Th>
              </>
            }
          >
            {rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <div className="font-medium text-ink">{row.requestedBy.name}</div>
                  <div className="text-xs text-ink-soft">
                    {row.attendanceRecord.assignment.project.name}
                  </div>
                </Td>
                <Td className="whitespace-nowrap tabular-nums">
                  {formatDate(row.attendanceRecord.workDate)}
                </Td>
                <Td className="text-xs text-ink-soft tabular-nums">
                  <div>in {formatIstTime(row.attendanceRecord.punchInAt)}</div>
                  <div>out {formatIstTime(row.attendanceRecord.punchOutAt)}</div>
                </Td>
                <Td className="text-xs tabular-nums">
                  <div>in {formatIstTime(row.requestedPunchIn)}</div>
                  <div>out {formatIstTime(row.requestedPunchOut)}</div>
                </Td>
                <Td className="text-ink-soft">{row.reason}</Td>
                <Td className="text-right whitespace-nowrap">
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => setRejecting(row.id)}>
                      Reject
                    </Button>
                    <Button onClick={() => void approve(row.id)} pending={decide.isPending}>
                      Approve
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </QueueState>

      <ReasonDialog
        open={Boolean(rejecting)}
        title="Reject this correction"
        label="Why is it being rejected?"
        hint="They see this, so say what would change your mind."
        confirmLabel="Reject correction"
        onClose={() => setRejecting(null)}
        onConfirm={async (reviewNote) => {
          await decide.mutateAsync({
            correctionId: rejecting!,
            decision: 'rejected',
            reviewNote,
          });
          setRejecting(null);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- leave */

function LeaveQueue({ query }: { query: ReturnType<typeof useLeaveRequests> }) {
  const decide = useDecideLeave();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function approve(leaveId: string) {
    setProblem(null);
    try {
      await decide.mutateAsync({ leaveId, decision: 'approved' });
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

      <QueueState
        query={query}
        emptyTitle="No leave waiting"
        emptyDescription="Requests from trainers on your projects appear here."
      >
        {(rows) => (
          <Table
            caption="Leave requests awaiting a decision"
            head={
              <>
                <Th>Trainer</Th>
                <Th>Dates</Th>
                <Th>Days</Th>
                <Th>Reason</Th>
                <Th>Waiting</Th>
                <Th className="text-right">Decision</Th>
              </>
            }
          >
            {rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <div className="font-medium text-ink">{row.assignment.trainer.user.name}</div>
                  <div className="text-xs text-ink-soft">{row.assignment.project.name}</div>
                </Td>
                <Td className="whitespace-nowrap tabular-nums">
                  {formatDate(row.startDate)}
                  {row.endDate !== row.startDate ? ` – ${formatDate(row.endDate)}` : ''}
                </Td>
                <Td className="tabular-nums">
                  {Number(row.daysCount)}
                  {Number(row.unpaidDays) > 0 ? (
                    <div className="text-xs font-medium text-danger">
                      {Number(row.unpaidDays)} beyond their balance
                    </div>
                  ) : null}
                </Td>
                <Td className="text-ink-soft">{row.reason}</Td>
                <Td>
                  {row.status === 'escalated' ? (
                    <Badge tone="critical">Escalated to you</Badge>
                  ) : (
                    <span className="text-xs text-ink-soft tabular-nums">
                      since {formatDate(row.createdAt)}
                    </span>
                  )}
                </Td>
                <Td className="text-right whitespace-nowrap">
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => setRejecting(row.id)}>
                      Reject
                    </Button>
                    <Button onClick={() => void approve(row.id)} pending={decide.isPending}>
                      Approve
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </QueueState>

      <ReasonDialog
        open={Boolean(rejecting)}
        title="Reject this leave request"
        label="Why is it being rejected?"
        hint="They will plan around this, so be clear about the reason."
        confirmLabel="Reject request"
        onClose={() => setRejecting(null)}
        onConfirm={async (decisionNote) => {
          await decide.mutateAsync({ leaveId: rejecting!, decision: 'rejected', decisionNote });
          setRejecting(null);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ claims */

function ClaimsQueue({ query }: { query: ReturnType<typeof useReimbursements> }) {
  const { can } = useAuth();
  const decide = useDecideClaim();
  const markPaid = useMarkClaimPaid();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const canApproveHighValue = can('reimbursements.approve_high_value');

  async function approve(claimId: string) {
    setProblem(null);
    try {
      await decide.mutateAsync({ claimId, decision: 'approved' });
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

      <QueueState
        query={query}
        emptyTitle="No claims waiting"
        emptyDescription="Expense claims submitted by trainers on your projects appear here."
      >
        {(rows) => (
          <Table
            caption="Claims awaiting a decision"
            head={
              <>
                <Th>Trainer</Th>
                <Th>Amount</Th>
                <Th>What for</Th>
                <Th>Receipt</Th>
                <Th>Status</Th>
                <Th className="text-right">Decision</Th>
              </>
            }
          >
            {rows.map((row) => {
              const highValue = Number(row.amount) > REIMBURSEMENT_HR_LIMIT;
              return (
                <tr key={row.id}>
                  <Td>
                    <div className="font-medium text-ink">{row.trainer.user.name}</div>
                    <div className="text-xs text-ink-soft">
                      {row.assignment?.project.name ?? '—'}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums font-medium">
                    {formatInr(row.amount)}
                    {highValue ? (
                      <div className="text-xs font-normal text-accent">Needs a manager</div>
                    ) : null}
                  </Td>
                  <Td className="text-ink-soft">
                    <div>{row.description}</div>
                    <div className="text-xs text-ink-faint">{humanise(row.category)}</div>
                  </Td>
                  <Td>
                    <Button variant="secondary" onClick={() => void openResume(row.proofFileId)}>
                      View
                    </Button>
                  </Td>
                  <Td>
                    <Badge tone={CLAIM_TONE[row.status] ?? 'neutral'}>{humanise(row.status)}</Badge>
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    <div className="flex justify-end gap-2">
                      {row.status === 'approved' && can('reimbursements.mark_paid') ? (
                        <Button onClick={() => setPaying(row.id)}>Mark paid</Button>
                      ) : row.status === 'submitted' ? (
                        <>
                          <Button variant="secondary" onClick={() => setRejecting(row.id)}>
                            Reject
                          </Button>
                          <Button
                            onClick={() => void approve(row.id)}
                            pending={decide.isPending}
                            // The API refuses this too; disabling it here means
                            // the refusal is visible before the click, not after.
                            disabled={highValue && !canApproveHighValue}
                          >
                            Approve
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </QueueState>

      <ReasonDialog
        open={Boolean(rejecting)}
        title="Reject this claim"
        label="Why is it being rejected?"
        hint="A rejected claim must say why — they may be able to resubmit."
        confirmLabel="Reject claim"
        onClose={() => setRejecting(null)}
        onConfirm={async (reviewNote) => {
          await decide.mutateAsync({ claimId: rejecting!, decision: 'rejected', reviewNote });
          setRejecting(null);
        }}
      />

      <PaymentDialog
        open={Boolean(paying)}
        onClose={() => setPaying(null)}
        pending={markPaid.isPending}
        onConfirm={async (reference) => {
          await markPaid.mutateAsync({ claimId: paying!, reference });
          setPaying(null);
        }}
      />
    </div>
  );
}

/* ----------------------------------------------------------------- dialogs */

function ReasonDialog({
  open,
  title,
  label,
  hint,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  label: string;
  hint: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  function close() {
    setReason('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function confirm() {
    setProblem(null);
    setFieldErrors({});
    setPending(true);
    try {
      await onConfirm(reason.trim());
      setReason('');
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} title={title} onClose={close}>
      <div className="space-y-5">
        {problem ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
          >
            {problem}
          </div>
        ) : null}

        <TextArea
          label={label}
          rows={3}
          required
          value={reason}
          hint={hint}
          error={Object.values(fieldErrors)[0]}
          onChange={(event) => setReason(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} pending={pending} disabled={!reason.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PaymentDialog({
  open,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: (reference: string) => Promise<void>;
}) {
  const [reference, setReference] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  async function confirm() {
    setProblem(null);
    try {
      await onConfirm(reference.trim());
      setReference('');
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={open}
      title="Record the payment"
      description="Marking a claim paid says the money has actually moved."
      onClose={onClose}
    >
      <div className="space-y-5">
        {problem ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
          >
            {problem}
          </div>
        ) : null}

        <Field
          label="Payment reference"
          value={reference}
          hint="The bank or payroll reference, so the payment can be traced later."
          onChange={(event) => setReference(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} pending={pending}>
            Mark paid
          </Button>
        </div>
      </div>
    </Modal>
  );
}
