import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Field,
  Modal,
  PageHeader,
  Select,
  Table,
  Tabs,
  Td,
  Th,
  TextArea,
} from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../auth/auth-context';
import { formatDate, formatInr, humanise } from '../onboarding/format';
import { QualitySummary } from '../reviews/summary';
import {
  downloadCsv,
  useCompleteDeboarding,
  useDeboarding,
  useDeboardings,
  useStartDeboarding,
  useUpdateDeboarding,
  type DeboardingRow,
} from './api';

const STAGE_TONE: Record<string, 'neutral' | 'positive' | 'pending' | 'critical'> = {
  initiated: 'pending',
  assets_pending: 'critical',
  fnf_pending: 'pending',
  completed: 'positive',
};

/**
 * Everyone winding down, and what is standing in each one's way.
 *
 * The screen leads with the blockers rather than the checklist, because that is
 * the only question anybody opens it to answer: what has to happen before this
 * person can actually leave.
 */
export function DeboardingPage() {
  const [tab, setTab] = useState<'open' | 'all'>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const deboardings = useDeboardings(tab === 'open' ? { open: true } : {});

  if (selected) {
    return <DeboardingDetail id={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <>
      <PageHeader
        title="Deboarding"
        description="Assets back, settlement closed, and whether we would take them again."
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              void downloadCsv('/deboardings/export.csv', 'managedops-deboardings.csv')
            }
          >
            Export CSV
          </Button>
        }
      />

      <Tabs
        label="Deboardings"
        active={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'open',
            label: 'In progress',
            count: tab === 'open' ? deboardings.data?.meta.total : undefined,
          },
          { id: 'all', label: 'All history' },
        ]}
      />

      <div className="mt-6">
        {deboardings.isPending ? (
          <LoadingState label="Loading deboardings" rows={3} />
        ) : deboardings.isError ? (
          <ErrorState error={deboardings.error} onRetry={() => void deboardings.refetch()} />
        ) : deboardings.data.data.length === 0 ? (
          <EmptyState
            title={tab === 'open' ? 'Nobody is leaving' : 'No deboardings recorded'}
            description="Start one from a trainer's profile when their assignment is ending."
          />
        ) : (
          <Table
            caption="Deboardings"
            head={
              <>
                <Th>Trainer</Th>
                <Th>Last day</Th>
                <Th>Assets</Th>
                <Th>Settlement</Th>
                <Th>Stage</Th>
                <Th className="text-right">Checklist</Th>
              </>
            }
          >
            {deboardings.data.data.map((row) => (
              <tr key={row.id}>
                <Td>
                  <div className="font-medium text-ink">{row.assignment.trainer.user.name}</div>
                  <div className="text-xs text-ink-soft tabular-nums">
                    {row.assignment.trainer.employeeCode} · {row.assignment.project.name}
                  </div>
                </Td>
                <Td className="whitespace-nowrap tabular-nums">{formatDate(row.lastWorkingDay)}</Td>
                <Td>
                  <Badge tone={row.assetsReconciled ? 'positive' : 'critical'}>
                    {row.assetsReconciled ? 'Reconciled' : 'Outstanding'}
                  </Badge>
                </Td>
                <Td>
                  <Badge tone={row.fnfStatus === 'pending' ? 'pending' : 'positive'}>
                    {humanise(row.fnfStatus)}
                  </Badge>
                  {row.fnfAmount ? (
                    <div className="mt-0.5 text-xs tabular-nums text-ink-soft">
                      {formatInr(row.fnfAmount)}
                    </div>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={STAGE_TONE[row.status] ?? 'neutral'}>{humanise(row.status)}</Badge>
                </Td>
                <Td className="text-right">
                  <Button variant="secondary" onClick={() => setSelected(row.id)}>
                    Open
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </>
  );
}

function DeboardingDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useAuth();
  const deboarding = useDeboarding(id);
  const complete = useCompleteDeboarding();
  const [problem, setProblem] = useState<string | null>(null);

  if (deboarding.isPending) return <LoadingState label="Loading the checklist" rows={4} />;
  if (deboarding.isError) {
    return <ErrorState error={deboarding.error} onRetry={() => void deboarding.refetch()} />;
  }

  const record = deboarding.data;
  const blockers = record.blockers;
  const editable = can('deboarding.manage') && record.status !== 'completed';

  async function finish() {
    setProblem(null);
    try {
      await complete.mutateAsync(id);
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <>
      <Button variant="ghost" onClick={onBack} className="-ml-3 mb-1">
        ← All deboardings
      </Button>

      <PageHeader
        title={record.assignment.trainer.user.name}
        description={`${record.assignment.trainer.employeeCode} · ${record.assignment.project.name} · last day ${formatDate(record.lastWorkingDay)}`}
        actions={
          <Badge tone={STAGE_TONE[record.status] ?? 'neutral'}>{humanise(record.status)}</Badge>
        }
      />

      <div className="space-y-6">
        {problem ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
          >
            {problem}
          </div>
        ) : null}

        {/* The blockers lead, because they are the only question this screen answers. */}
        {record.status === 'completed' ? (
          <div className="rounded-md border border-primary/30 bg-primary-wash px-4 py-3 text-sm">
            <p className="font-medium text-primary">
              Completed on {formatDate(record.completedAt)}.
            </p>
            <p className="mt-0.5 text-ink">
              {record.assignment.trainer.rehireEligible
                ? 'Marked re-hire eligible, so they appear in the Talent Pool.'
                : 'Not marked re-hire eligible, so they are not in the Talent Pool.'}
            </p>
          </div>
        ) : blockers?.canComplete ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary-wash px-4 py-3 text-sm">
            <p className="font-medium text-primary">
              Everything is settled. This deboarding can be completed.
            </p>
            {editable ? (
              <Button onClick={() => void finish()} pending={complete.isPending}>
                Complete deboarding
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-accent/30 bg-accent-wash px-4 py-3 text-sm">
            <p className="font-medium text-accent">Not yet — this is what is outstanding.</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink">
              {blockers?.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </div>
        )}

        {blockers && blockers.outstandingAssets.length > 0 ? (
          <Card title="Assets still out" description="Reconcile these from the trainer's profile.">
            <ul className="space-y-2 text-sm">
              {blockers.outstandingAssets.map((asset) => (
                <li key={asset.id} className="flex items-center justify-between gap-3">
                  <span className="text-ink">
                    {asset.name}
                    {asset.serialNumber ? (
                      <span className="ml-2 text-xs tabular-nums text-ink-soft">
                        {asset.serialNumber}
                      </span>
                    ) : null}
                  </span>
                  <Badge tone={asset.status === 'issued' ? 'pending' : 'critical'}>
                    {humanise(asset.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <ChecklistForm record={record} editable={editable} />

        <Card title="Why they are leaving">
          <p className="text-sm text-ink">{record.reason}</p>
          <p className="mt-2 text-xs text-ink-faint">
            Started by {record.initiatedBy.name} on {formatDate(record.createdAt)}.
          </p>
        </Card>
      </div>
    </>
  );
}

function ChecklistForm({ record, editable }: { record: DeboardingRow; editable: boolean }) {
  const update = useUpdateDeboarding();
  const [fnfStatus, setFnfStatus] = useState(record.fnfStatus);
  const [fnfAmount, setFnfAmount] = useState(record.fnfAmount ?? '');
  const [travelNotes, setTravelNotes] = useState(record.travelNotes ?? '');
  const [feedback, setFeedback] = useState(record.feedback ?? '');
  const [rehireEligible, setRehireEligible] = useState(record.assignment.trainer.rehireEligible);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  async function save() {
    setProblem(null);
    setFieldErrors({});
    setSaved(false);
    try {
      await update.mutateAsync({
        id: record.id,
        fnfStatus,
        ...(fnfAmount !== '' ? { fnfAmount: Number(fnfAmount) } : {}),
        travelNotes,
        feedback,
        rehireEligible,
      });
      setSaved(true);
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Card
      title="The checklist"
      description="Asset reconciliation is read from the register, not typed here."
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

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Full and final settlement"
            value={fnfStatus}
            disabled={!editable}
            onChange={(event) => setFnfStatus(event.target.value as DeboardingRow['fnfStatus'])}
          >
            <option value="pending">Pending</option>
            <option value="settled">Settled</option>
            <option value="waived">Waived</option>
          </Select>
          <Field
            label="Amount (₹)"
            type="number"
            min="0"
            value={fnfAmount}
            disabled={!editable || fnfStatus !== 'settled'}
            error={fieldErrors.fnfAmount}
            hint={fnfStatus === 'settled' ? 'A settled amount has to say how much.' : undefined}
            onChange={(event) => setFnfAmount(event.target.value)}
          />
        </div>

        <TextArea
          label="Travel"
          rows={2}
          value={travelNotes}
          disabled={!editable}
          hint="Return travel arranged, and anything outstanding on it."
          onChange={(event) => setTravelNotes(event.target.value)}
        />

        <TextArea
          label="Exit feedback"
          rows={3}
          value={feedback}
          disabled={!editable}
          hint="What they were good at, and what a future project should know."
          onChange={(event) => setFeedback(event.target.value)}
        />

        {/* The evidence, immediately above the box that decides on it. Until
            feedback existed this was a tick with nothing behind it. */}
        {record.quality ? (
          <div className="rounded-md border border-line bg-surface-sunk px-3 py-3">
            <p className="mb-2 text-xs font-medium tracking-wide text-ink-soft uppercase">
              How they were rated
            </p>
            <QualitySummary summary={record.quality} compact />
          </div>
        ) : null}

        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={rehireEligible}
            disabled={!editable}
            onChange={(event) => setRehireEligible(event.target.checked)}
          />
          <span>
            <span className="font-medium text-ink">Eligible for re-hire</span>
            <span className="block text-xs text-ink-soft">
              Ticking this is what puts them in the Talent Pool when the deboarding completes.
              Un-ticking it takes them straight back out.
            </span>
          </span>
        </label>

        {editable ? (
          <div className="flex items-center justify-end gap-3">
            {saved ? <span className="text-xs text-ink-soft">Saved.</span> : null}
            <Button onClick={() => void save()} pending={update.isPending}>
              Save checklist
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Starting a deboarding, from a trainer's profile. */
export function StartDeboardingDialog({
  assignmentId,
  trainerName,
  open,
  onClose,
  onStarted,
}: {
  assignmentId: string;
  trainerName: string;
  open: boolean;
  onClose: () => void;
  onStarted?: () => void;
}) {
  const [lastWorkingDay, setLastWorkingDay] = useState(
    new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  );
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const start = useStartDeboarding();

  function close() {
    setReason('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function submit() {
    setProblem(null);
    setFieldErrors({});
    try {
      await start.mutateAsync({ assignmentId, lastWorkingDay, reason: reason.trim() });
      close();
      onStarted?.();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={open}
      title={`Start deboarding ${trainerName}`}
      description="They stay on the roster and keep punching in until their last day passes."
      onClose={close}
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
          label="Last working day"
          type="date"
          value={lastWorkingDay}
          error={fieldErrors.lastWorkingDay}
          onChange={(event) => setLastWorkingDay(event.target.value)}
        />

        <TextArea
          label="Why are they leaving?"
          rows={3}
          required
          value={reason}
          error={fieldErrors.reason}
          hint="This is what the Talent Pool shows if they are eligible for re-hire."
          onChange={(event) => setReason(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={start.isPending}
            disabled={reason.trim().length < 5}
          >
            Start deboarding
          </Button>
        </div>
      </div>
    </Modal>
  );
}
