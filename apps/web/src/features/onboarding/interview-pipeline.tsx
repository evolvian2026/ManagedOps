import { useState } from 'react';
import { ApiError, errorMessage } from '../../lib/api';
import { Badge, Button, Field, Modal, Table, Td, TextArea, Th, Tabs } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import {
  useAwaitingSchedule,
  useInterviews,
  useMarkMissed,
  usePipeline,
  useRecordOutcome,
  useRescheduleInterview,
  useScheduleInterview,
  type ApplicationRow,
  type InterviewRow,
  type PipelineCard,
} from './api';
import {
  STATUS_TONE,
  defaultInterviewSlot,
  formatIst,
  fromIstInputValue,
  humanise,
} from './format';

type Tab = 'scheduled' | 'conducted' | 'missed';

/**
 * The interview board: position cards first, then the three states a round can
 * be in for that position. "To be scheduled" is derived from applications with
 * no live round rather than stored, so it can never drift from the interviews.
 */
export function InterviewPipeline() {
  const [selected, setSelected] = useState<PipelineCard | null>(null);
  const pipeline = usePipeline();

  if (pipeline.isPending) return <LoadingState label="Loading the interview pipeline" rows={3} />;
  if (pipeline.isError) {
    return <ErrorState error={pipeline.error} onRetry={() => void pipeline.refetch()} />;
  }

  if (selected) {
    // Re-read from the live list so counts stay fresh after a mutation.
    const current =
      pipeline.data.data.find((card) => card.position.id === selected.position.id) ?? selected;
    return <PositionInterviews card={current} onBack={() => setSelected(null)} />;
  }

  if (pipeline.data.data.length === 0) {
    return (
      <EmptyState
        title="Nobody is at the interview stage"
        description="Screen an applicant through from Open Positions and they will appear here, ready to be booked."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {pipeline.data.data.map((card) => (
        <button
          key={card.position.id}
          type="button"
          onClick={() => setSelected(card)}
          className="rounded-lg border border-line bg-surface p-5 text-left transition-colors hover:border-primary/40 hover:bg-primary-wash/30"
        >
          <h3 className="truncate text-sm font-semibold text-ink">{card.position.title}</h3>
          <p className="mt-0.5 truncate text-sm text-ink-soft">{card.position.project.name}</p>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Stat
              label="To schedule"
              value={card.toBeScheduled}
              emphasise={card.toBeScheduled > 0}
            />
            <Stat label="Scheduled" value={card.scheduled} />
            <Stat label="Conducted" value={card.conducted} />
            <Stat label="Missed" value={card.missed} warn={card.missed > 0} />
          </dl>
        </button>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  emphasise,
  warn,
}: {
  label: string;
  value: number;
  emphasise?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd
        className={`text-lg font-semibold tabular-nums ${
          warn && value > 0 ? 'text-danger' : emphasise && value > 0 ? 'text-accent' : 'text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function PositionInterviews({ card, onBack }: { card: PipelineCard; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('scheduled');
  const [scheduling, setScheduling] = useState<ApplicationRow | null>(null);
  const [rescheduling, setRescheduling] = useState<InterviewRow | null>(null);
  const [recording, setRecording] = useState<InterviewRow | null>(null);

  const interviews = useInterviews(card.position.id);
  const awaiting = useAwaitingSchedule(card.position.id);
  const markMissed = useMarkMissed();

  const rounds = interviews.data?.data ?? [];
  const scheduled = rounds.filter((row) => row.status === 'scheduled');
  const conducted = rounds.filter((row) => row.status === 'completed');
  const missed = rounds.filter((row) => row.status === 'missed');

  // Only applications with no live round belong in "to be scheduled".
  const bookedApplicationIds = new Set(scheduled.map((row) => row.application.id));
  const toSchedule = (awaiting.data?.data ?? []).filter(
    (application) => !bookedApplicationIds.has(application.id),
  );

  return (
    <div className="space-y-4">
      <div>
        <Button variant="ghost" onClick={onBack} className="-ml-3 mb-1">
          ← All positions
        </Button>
        <h2 className="text-lg font-semibold text-ink">{card.position.title}</h2>
        <p className="text-sm text-ink-soft">{card.position.project.name}</p>
      </div>

      <Tabs
        label="Interview stages"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'scheduled', label: 'Scheduled', count: scheduled.length + toSchedule.length },
          { id: 'conducted', label: 'Conducted', count: conducted.length },
          { id: 'missed', label: 'Missed', count: missed.length },
        ]}
      />

      {interviews.isPending || awaiting.isPending ? (
        <LoadingState label="Loading interviews" rows={3} />
      ) : interviews.isError ? (
        <ErrorState error={interviews.error} onRetry={() => void interviews.refetch()} />
      ) : tab === 'scheduled' ? (
        <ScheduledTab
          toSchedule={toSchedule}
          scheduled={scheduled}
          onSchedule={setScheduling}
          onRecord={setRecording}
          onMissed={(row) => void markMissed.mutateAsync({ id: row.id })}
        />
      ) : tab === 'conducted' ? (
        <ConductedTab rounds={conducted} />
      ) : (
        <MissedTab rounds={missed} onReschedule={setRescheduling} />
      )}

      <ScheduleDialog application={scheduling} onClose={() => setScheduling(null)} />
      <RescheduleDialog interview={rescheduling} onClose={() => setRescheduling(null)} />
      <OutcomeDialog interview={recording} onClose={() => setRecording(null)} />
    </div>
  );
}

function ScheduledTab({
  toSchedule,
  scheduled,
  onSchedule,
  onRecord,
  onMissed,
}: {
  toSchedule: ApplicationRow[];
  scheduled: InterviewRow[];
  onSchedule: (application: ApplicationRow) => void;
  onRecord: (interview: InterviewRow) => void;
  onMissed: (interview: InterviewRow) => void;
}) {
  if (toSchedule.length === 0 && scheduled.length === 0) {
    return (
      <EmptyState
        title="Nothing waiting"
        description="Everyone screened through for this position has been interviewed."
      />
    );
  }

  return (
    <div className="space-y-6">
      {toSchedule.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">
            To be scheduled
            <span className="ml-2 font-normal text-ink-soft">({toSchedule.length})</span>
          </h3>
          <Table
            caption="Applicants waiting for an interview slot"
            head={
              <>
                <Th>Candidate</Th>
                <Th>Contact</Th>
                <Th className="text-right">Action</Th>
              </>
            }
          >
            {toSchedule.map((application) => (
              <tr key={application.id}>
                <Td className="font-medium">{application.candidate.name}</Td>
                <Td className="text-ink-soft">
                  <div>{application.candidate.email}</div>
                  <div className="text-xs tabular-nums">{application.candidate.phone}</div>
                </Td>
                <Td className="text-right">
                  <Button onClick={() => onSchedule(application)}>Schedule</Button>
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      ) : null}

      {scheduled.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">
            Booked<span className="ml-2 font-normal text-ink-soft">({scheduled.length})</span>
          </h3>
          <Table
            caption="Interviews already booked"
            head={
              <>
                <Th>Candidate</Th>
                <Th>When</Th>
                <Th>Interviewer</Th>
                <Th>Link</Th>
                <Th className="text-right">Action</Th>
              </>
            }
          >
            {scheduled.map((interview) => (
              <tr key={interview.id}>
                <Td>
                  <div className="font-medium">{interview.application.candidate.name}</div>
                  <div className="text-xs text-ink-soft">Round {interview.round}</div>
                </Td>
                <Td className="whitespace-nowrap text-ink-soft tabular-nums">
                  {formatIst(interview.scheduledAt)}
                </Td>
                <Td className="text-ink-soft">{interview.interviewer?.name ?? 'Unassigned'}</Td>
                <Td>
                  {interview.meetingUrl ? (
                    <a
                      href={interview.meetingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary underline underline-offset-2"
                    >
                      Join
                    </a>
                  ) : (
                    <span className="text-xs text-ink-faint">None</span>
                  )}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => onMissed(interview)}>
                      Missed
                    </Button>
                    <Button onClick={() => onRecord(interview)}>Record result</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      ) : null}
    </div>
  );
}

function ConductedTab({ rounds }: { rounds: InterviewRow[] }) {
  if (rounds.length === 0) {
    return (
      <EmptyState
        title="No interviews conducted yet"
        description="Once a result is recorded, the interview and its feedback appear here."
      />
    );
  }

  return (
    <Table
      caption="Interviews that have been conducted"
      head={
        <>
          <Th>Candidate</Th>
          <Th>When</Th>
          <Th>Result</Th>
          <Th>Feedback</Th>
          <Th>Recording</Th>
        </>
      }
    >
      {rounds.map((interview) => (
        <tr key={interview.id}>
          <Td>
            <div className="font-medium">{interview.application.candidate.name}</div>
            <div className="text-xs text-ink-soft">Round {interview.round}</div>
          </Td>
          <Td className="whitespace-nowrap text-ink-soft tabular-nums">
            {formatIst(interview.scheduledAt)}
          </Td>
          <Td>
            <Badge tone={interview.outcome === 'selected' ? 'positive' : 'critical'}>
              {humanise(interview.outcome)}
            </Badge>
          </Td>
          <Td className="max-w-[32ch] text-ink-soft">{interview.feedback ?? '—'}</Td>
          <Td>
            {interview.recordingUrl ? (
              <a
                href={interview.recordingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary underline underline-offset-2"
              >
                Watch
              </a>
            ) : (
              <span className="text-xs text-ink-faint">None</span>
            )}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

function MissedTab({
  rounds,
  onReschedule,
}: {
  rounds: InterviewRow[];
  onReschedule: (interview: InterviewRow) => void;
}) {
  if (rounds.length === 0) {
    return (
      <EmptyState
        title="No missed interviews"
        description="Nobody has no-showed for this position."
      />
    );
  }

  return (
    <Table
      caption="Interviews that were missed"
      head={
        <>
          <Th>Candidate</Th>
          <Th>Was booked for</Th>
          <Th>Contact</Th>
          <Th className="text-right">Action</Th>
        </>
      }
    >
      {rounds.map((interview) => (
        <tr key={interview.id}>
          <Td>
            <div className="font-medium">{interview.application.candidate.name}</div>
            <div className="text-xs text-ink-soft">Round {interview.round}</div>
          </Td>
          <Td className="whitespace-nowrap text-ink-soft tabular-nums">
            {formatIst(interview.scheduledAt)}
          </Td>
          <Td className="text-ink-soft">
            <div>{interview.application.candidate.email}</div>
            <div className="text-xs tabular-nums">{interview.application.candidate.phone}</div>
          </Td>
          <Td className="text-right">
            <Button onClick={() => onReschedule(interview)}>Reschedule</Button>
          </Td>
        </tr>
      ))}
    </Table>
  );
}

/* ------------------------------------------------------------- dialogues */

function useSlotForm() {
  const [slot, setSlot] = useState(defaultInterviewSlot());
  const [meetingUrl, setMeetingUrl] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function reset() {
    setSlot(defaultInterviewSlot());
    setMeetingUrl('');
    setProblem(null);
    setFieldErrors({});
  }

  function capture(error: unknown) {
    if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
    setProblem(errorMessage(error));
  }

  return { slot, setSlot, meetingUrl, setMeetingUrl, problem, fieldErrors, reset, capture };
}

function SlotFields({ form }: { form: ReturnType<typeof useSlotForm> }) {
  return (
    <>
      {form.problem ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
        >
          {form.problem}
        </div>
      ) : null}

      <Field
        label="Date and time"
        type="datetime-local"
        required
        value={form.slot}
        error={form.fieldErrors.scheduledAt}
        hint="Entered and shown in IST, wherever you happen to be."
        onChange={(event) => form.setSlot(event.target.value)}
      />
      <Field
        label="Meeting link"
        type="url"
        placeholder="https://meet.example.com/..."
        value={form.meetingUrl}
        error={form.fieldErrors.meetingUrl}
        hint="Sent to the candidate with their confirmation and reminders."
        onChange={(event) => form.setMeetingUrl(event.target.value)}
      />
    </>
  );
}

function ScheduleDialog({
  application,
  onClose,
}: {
  application: ApplicationRow | null;
  onClose: () => void;
}) {
  const form = useSlotForm();
  const schedule = useScheduleInterview();

  function close() {
    form.reset();
    onClose();
  }

  async function submit() {
    if (!application) return;
    try {
      await schedule.mutateAsync({
        applicationId: application.id,
        scheduledAt: fromIstInputValue(form.slot),
        meetingUrl: form.meetingUrl.trim() || undefined,
      });
      close();
    } catch (error) {
      form.capture(error);
    }
  }

  return (
    <Modal
      open={Boolean(application)}
      title="Schedule an interview"
      description={application?.candidate.name}
      onClose={close}
    >
      <div className="space-y-5">
        <SlotFields form={form} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={schedule.isPending}>
            Schedule and notify
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RescheduleDialog({
  interview,
  onClose,
}: {
  interview: InterviewRow | null;
  onClose: () => void;
}) {
  const form = useSlotForm();
  const reschedule = useRescheduleInterview();

  function close() {
    form.reset();
    onClose();
  }

  async function submit() {
    if (!interview) return;
    try {
      await reschedule.mutateAsync({
        id: interview.id,
        scheduledAt: fromIstInputValue(form.slot),
        meetingUrl: form.meetingUrl.trim() || undefined,
      });
      close();
    } catch (error) {
      form.capture(error);
    }
  }

  return (
    <Modal
      open={Boolean(interview)}
      title="Reschedule"
      description={
        interview
          ? `${interview.application.candidate.name} — was booked for ${formatIst(interview.scheduledAt)}`
          : undefined
      }
      onClose={close}
    >
      <div className="space-y-5">
        <p className="rounded-md bg-surface-sunk px-3 py-2 text-sm text-ink-soft">
          This books a new round. The missed one stays on the record.
        </p>
        <SlotFields form={form} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={reschedule.isPending}>
            Book new round
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function OutcomeDialog({
  interview,
  onClose,
}: {
  interview: InterviewRow | null;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<'selected' | 'rejected'>('selected');
  const [feedback, setFeedback] = useState('');
  const [recordingUrl, setRecordingUrl] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const record = useRecordOutcome();

  function close() {
    setOutcome('selected');
    setFeedback('');
    setRecordingUrl('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function submit() {
    if (!interview) return;
    setProblem(null);
    setFieldErrors({});

    try {
      await record.mutateAsync({
        id: interview.id,
        outcome,
        feedback: feedback.trim(),
        recordingUrl: recordingUrl.trim() || undefined,
      });
      close();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={Boolean(interview)}
      title="Record the interview result"
      description={interview?.application.candidate.name}
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
          <legend className="mb-1 text-sm font-medium text-ink">Result</legend>
          {(
            [
              ['selected', 'Selected', 'Moves them to the offer stage.'],
              ['rejected', 'Not selected', 'Closes the application and keeps them in the pool.'],
            ] as const
          ).map(([value, label, consequence]) => (
            <label
              key={value}
              className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${
                outcome === value
                  ? 'border-primary bg-primary-wash/40'
                  : 'border-line hover:bg-surface-sunk'
              }`}
            >
              <input
                type="radio"
                name="interview-outcome"
                checked={outcome === value}
                onChange={() => setOutcome(value)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-ink">{label}</span>
                <span className="mt-0.5 block text-xs text-ink-soft">{consequence}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <TextArea
          label="Feedback"
          rows={3}
          required
          value={feedback}
          error={fieldErrors.feedback}
          hint="If they are not selected, this becomes the reason on their pool entry."
          onChange={(event) => setFeedback(event.target.value)}
        />
        <Field
          label="Recording link"
          type="url"
          value={recordingUrl}
          error={fieldErrors.recordingUrl}
          onChange={(event) => setRecordingUrl(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={record.isPending}>
            {outcome === 'selected' ? 'Select and move to offer' : 'Record result'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export { STATUS_TONE };
