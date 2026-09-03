import { useState } from 'react';
import type { ScreeningOutcome } from '@managedops/shared';
import { ApiError, errorMessage } from '../../lib/api';
import { Badge, Button, Modal, Table, Td, TextArea, Th } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import {
  openResume,
  useApplications,
  usePositions,
  useScreenApplication,
  type ApplicationRow,
  type PositionRow,
} from './api';
import { STATUS_TONE, formatDate, humanise } from './format';

/**
 * Open Positions.
 *
 * The card grid is the entry point; selecting a card replaces it with that
 * position's applicants, exactly as the specification describes. Screening
 * happens inline on a row, because that is one decision on one person and does
 * not deserve a page of its own.
 */
export function OpenPositions() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const positions = usePositions();

  if (positions.isPending) return <LoadingState label="Loading open positions" rows={3} />;
  if (positions.isError) {
    return <ErrorState error={positions.error} onRetry={() => void positions.refetch()} />;
  }

  const selected = positions.data.data.find((row) => row.id === selectedId);
  if (selected) {
    return <ApplicationsForPosition position={selected} onBack={() => setSelectedId(null)} />;
  }

  if (positions.data.data.length === 0) {
    return (
      <EmptyState
        title="No positions are open"
        description="Positions are opened against a project. Once one exists, applicants appear here as they are entered."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {positions.data.data.map((position) => (
        <PositionCard
          key={position.id}
          position={position}
          onOpen={() => setSelectedId(position.id)}
        />
      ))}
    </div>
  );
}

function PositionCard({ position, onOpen }: { position: PositionRow; onOpen: () => void }) {
  const { applicants } = position;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-lg border border-line bg-surface p-5 text-left transition-colors hover:border-primary/40 hover:bg-primary-wash/30"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink">{position.title}</h3>
          {/* Project and client each get their own line: run together they
              truncate into an ellipsis that hides which client it is for. */}
          <p className="mt-0.5 truncate text-sm text-ink-soft">{position.project.name}</p>
          <p className="truncate text-xs text-ink-faint">{position.project.clientName}</p>
        </div>
        <Badge tone={STATUS_TONE[position.status] ?? 'neutral'}>{humanise(position.status)}</Badge>
      </div>

      <p className="mt-4 text-2xl font-semibold text-ink tabular-nums">
        {applicants.total}
        <span className="ml-1.5 text-sm font-normal text-ink-soft">
          {applicants.total === 1 ? 'applicant' : 'applicants'}
        </span>
      </p>

      <StageBar counts={applicants} />

      <p className="mt-3 text-xs text-ink-soft tabular-nums">
        {position.filledCount} of {position.headcount} filled
      </p>
    </button>
  );
}

/** A single bar showing where a position's applicants actually sit. */
function StageBar({ counts }: { counts: PositionRow['applicants'] }) {
  const segments = [
    { key: 'applied', label: 'Applied', value: counts.applied, className: 'bg-line-strong' },
    {
      key: 'interviewing',
      label: 'Interviewing',
      value: counts.interviewing,
      className: 'bg-accent',
    },
    { key: 'offer', label: 'At offer', value: counts.offer, className: 'bg-primary/60' },
    { key: 'hired', label: 'Hired', value: counts.hired, className: 'bg-primary' },
  ].filter((segment) => segment.value > 0);

  if (segments.length === 0) {
    return <p className="mt-3 text-xs text-ink-faint">Nobody in the pipeline yet</p>;
  }

  const live = segments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <>
      <div className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
        {segments.map((segment) => (
          <span
            key={segment.key}
            className={segment.className}
            style={{ width: `${(segment.value / live) * 100}%` }}
          />
        ))}
      </div>
      {/* The bar is decoration; the counts themselves carry the meaning. */}
      <p className="mt-2 text-xs text-ink-soft">
        {segments.map((segment) => `${segment.value} ${segment.label.toLowerCase()}`).join(' · ')}
      </p>
    </>
  );
}

function ApplicationsForPosition({
  position,
  onBack,
}: {
  position: PositionRow;
  onBack: () => void;
}) {
  const applications = useApplications(position.id);
  const [screening, setScreening] = useState<ApplicationRow | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button variant="ghost" onClick={onBack} className="-ml-3 mb-1">
            ← All positions
          </Button>
          <h2 className="text-lg font-semibold text-ink">{position.title}</h2>
          <p className="text-sm text-ink-soft">
            {position.project.name} · {position.project.clientName} · {position.filledCount} of{' '}
            {position.headcount} filled
          </p>
        </div>
      </div>

      {applications.isPending ? (
        <LoadingState label="Loading applicants" rows={4} />
      ) : applications.isError ? (
        <ErrorState error={applications.error} onRetry={() => void applications.refetch()} />
      ) : applications.data.data.length === 0 ? (
        <EmptyState
          title="No applicants yet"
          description="Candidates entered against this position will appear here, ready for a screening call."
        />
      ) : (
        <Table
          caption={`Applicants for ${position.title}`}
          head={
            <>
              <Th>Candidate</Th>
              <Th>Contact</Th>
              <Th>Applied</Th>
              <Th>Status</Th>
              <Th className="text-right">Screening</Th>
            </>
          }
        >
          {applications.data.data.map((application) => (
            <ApplicationRowView
              key={application.id}
              application={application}
              onScreen={() => setScreening(application)}
            />
          ))}
        </Table>
      )}

      <ScreeningDialog application={screening} onClose={() => setScreening(null)} />
    </div>
  );
}

function ApplicationRowView({
  application,
  onScreen,
}: {
  application: ApplicationRow;
  onScreen: () => void;
}) {
  const { candidate } = application;
  const awaitingScreening = application.status === 'applied' || application.status === 'screening';

  return (
    <tr>
      <Td>
        <div className="font-medium text-ink">{candidate.name}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs">
          {candidate.resumeFileId ? (
            <button
              type="button"
              onClick={() => void openResume(candidate.resumeFileId!)}
              className="text-primary underline underline-offset-2"
            >
              Resume
            </button>
          ) : (
            <span className="text-ink-faint">No resume</span>
          )}
          {candidate.linkedinUrl ? (
            <a
              href={candidate.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              LinkedIn
            </a>
          ) : null}
          {candidate.workedBefore ? <Badge tone="positive">Worked with us</Badge> : null}
        </div>
      </Td>
      <Td className="text-ink-soft">
        <div>{candidate.email}</div>
        <div className="text-xs tabular-nums">{candidate.phone}</div>
      </Td>
      <Td className="text-ink-soft tabular-nums">{formatDate(application.createdAt)}</Td>
      <Td>
        <Badge tone={STATUS_TONE[application.status] ?? 'neutral'}>
          {humanise(application.status)}
        </Badge>
        {application.rejectionReason ? (
          <p className="mt-1 max-w-[22ch] text-xs text-ink-soft">{application.rejectionReason}</p>
        ) : null}
      </Td>
      <Td className="text-right">
        {awaitingScreening ? (
          <Button variant="secondary" onClick={onScreen}>
            Record call
          </Button>
        ) : (
          <span className="text-xs text-ink-faint">
            {application.screenedBy ? `Screened by ${application.screenedBy.name}` : 'Screened'}
          </span>
        )}
      </Td>
    </tr>
  );
}

/**
 * The screening call's three outcomes, worded as the person making the call
 * would say them rather than as the enum values behind them.
 */
const OUTCOMES: { value: ScreeningOutcome; label: string; consequence: string }[] = [
  {
    value: 'proceed',
    label: 'Yes, proceed with an interview',
    consequence: 'Moves them into the interview pipeline.',
  },
  {
    value: 'not_available',
    label: 'No, not available',
    consequence: 'Closes this application and keeps them in the talent pool.',
  },
  {
    value: 'reject',
    label: 'Reject',
    consequence: 'Closes this application with a reason, and keeps them in the pool.',
  },
];

function ScreeningDialog({
  application,
  onClose,
}: {
  application: ApplicationRow | null;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<ScreeningOutcome>('proceed');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const screen = useScreenApplication();

  function close() {
    setOutcome('proceed');
    setNotes('');
    setReason('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function submit() {
    if (!application) return;
    setProblem(null);
    setFieldErrors({});

    try {
      await screen.mutateAsync({
        id: application.id,
        outcome,
        notes: notes.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      close();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  const chosen = OUTCOMES.find((option) => option.value === outcome);

  return (
    <Modal
      open={Boolean(application)}
      title="Record the screening call"
      description={
        application ? `${application.candidate.name} — ${application.position.title}` : undefined
      }
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

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-ink">What was the outcome?</legend>
          {OUTCOMES.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${
                outcome === option.value
                  ? 'border-primary bg-primary-wash/40'
                  : 'border-line hover:bg-surface-sunk'
              }`}
            >
              <input
                type="radio"
                name="screening-outcome"
                value={option.value}
                checked={outcome === option.value}
                onChange={() => setOutcome(option.value)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-ink">{option.label}</span>
                <span className="mt-0.5 block text-xs text-ink-soft">{option.consequence}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {outcome === 'reject' ? (
          <TextArea
            label="Reason for rejecting"
            rows={2}
            required
            value={reason}
            error={fieldErrors.reason}
            hint="Recorded on their pool entry, so a future opening has the context."
            onChange={(event) => setReason(event.target.value)}
          />
        ) : null}

        <TextArea
          label="Call notes"
          rows={3}
          value={notes}
          error={fieldErrors.notes}
          placeholder="Anything worth knowing before the next stage"
          onChange={(event) => setNotes(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={screen.isPending}>
            {chosen?.value === 'proceed' ? 'Move to interview' : 'Record outcome'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
