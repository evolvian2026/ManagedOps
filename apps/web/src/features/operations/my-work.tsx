import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
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
import { formatDate, formatIstTime, humanise } from '../onboarding/format';
import { openResume } from '../onboarding/api';
import { uploadFile } from '../workforce/api';
import { PunchCard, toneFor } from './punch-card';
import {
  useAddDailyLog,
  useAttendanceCalendar,
  useDailyLogs,
  useDeliverables,
  useMyAssets,
  useRequestCorrection,
  useUpdateDeliverable,
  type CalendarDay,
  type DeliverableRow,
} from './api';

type Tab = 'today' | 'attendance' | 'log' | 'deliverables' | 'resources';

/** `YYYY-MM` for the month a date falls in, in IST. */
function istMonth(offsetMonths = 0): string {
  const now = new Date(Date.now() + 330 * 60_000);
  now.setUTCMonth(now.getUTCMonth() + offsetMonths);
  return now.toISOString().slice(0, 7);
}

function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * Everything a trainer does on a working day, in one screen.
 *
 * Five tabs rather than five sidebar entries: they are all the same assignment
 * on the same day, and splitting them across the navigation would make a
 * trainer hunt for the place to record a session they have just taught.
 */
export function MyWorkPage() {
  const [tab, setTab] = useState<Tab>('today');

  return (
    <>
      <PageHeader title="My Work" description="Your day, your record of it, and what you owe." />

      <Tabs
        label="My work"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'today', label: 'Today' },
          { id: 'attendance', label: 'Attendance' },
          { id: 'log', label: 'Daily Log' },
          { id: 'deliverables', label: 'Deliverables' },
          { id: 'resources', label: 'Resources' },
        ]}
      />

      <div className="mt-6">
        {tab === 'today' ? <PunchCard /> : null}
        {tab === 'attendance' ? <AttendanceTab /> : null}
        {tab === 'log' ? <DailyLogTab /> : null}
        {tab === 'deliverables' ? <DeliverablesTab /> : null}
        {tab === 'resources' ? <ResourcesTab /> : null}
      </div>
    </>
  );
}

/* -------------------------------------------------------------- attendance */

function AttendanceTab() {
  const [month, setMonth] = useState(istMonth());
  const [correcting, setCorrecting] = useState<CalendarDay | null>(null);
  const calendar = useAttendanceCalendar(month);

  if (calendar.isPending) return <LoadingState label="Loading your attendance" rows={5} />;
  if (calendar.isError) {
    return <ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} />;
  }

  const { days, summary } = calendar.data;
  const today = istToday();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setMonth(shiftMonth(month, -1))}>
            ← Previous
          </Button>
          <span className="text-sm font-medium text-ink">{monthLabel(month)}</span>
          <Button
            variant="secondary"
            disabled={month >= istMonth()}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            Next →
          </Button>
        </div>

        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <Stat label="Present" value={summary.present} />
          <Stat label="Late" value={summary.late} />
          <Stat label="Absent" value={summary.absent} />
          <Stat label="On leave" value={summary.onLeave} />
          {summary.openIssues > 0 ? (
            <Stat label="Needs attention" value={summary.openIssues} />
          ) : null}
        </dl>
      </div>

      <Table
        caption={`Attendance for ${monthLabel(month)}`}
        head={
          <>
            <Th>Date</Th>
            <Th>In</Th>
            <Th>Out</Th>
            <Th>Status</Th>
            <Th className="text-right">Correction</Th>
          </>
        }
      >
        {days
          // Days that have not happened yet are not a record of anything.
          .filter((day) => day.workDate <= today)
          .reverse()
          .map((day) => (
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
                {day.derived && day.status !== 'absent' ? (
                  <span className="ml-2 text-xs text-ink-faint">from the project calendar</span>
                ) : null}
              </Td>
              <Td className="text-right">
                {canCorrect(day) ? (
                  <Button variant="secondary" onClick={() => setCorrecting(day)}>
                    Ask to correct
                  </Button>
                ) : day.status === 'correction_pending' ? (
                  <span className="text-xs text-ink-soft">Awaiting a decision</span>
                ) : null}
              </Td>
            </tr>
          ))}
      </Table>

      <CorrectionDialog day={correcting} onClose={() => setCorrecting(null)} />
    </div>
  );
}

/** Only a day with a stored record and an unresolved problem can be corrected. */
function canCorrect(day: CalendarDay): boolean {
  return Boolean(day.record) && ['missing_punch_out', 'absent', 'late'].includes(day.status);
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function CorrectionDialog({ day, onClose }: { day: CalendarDay | null; onClose: () => void }) {
  const [punchIn, setPunchIn] = useState('');
  const [punchOut, setPunchOut] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const request = useRequestCorrection();

  function close() {
    setPunchIn('');
    setPunchOut('');
    setReason('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function submit() {
    if (!day?.record) return;
    setProblem(null);
    setFieldErrors({});
    try {
      await request.mutateAsync({
        recordId: day.record.id,
        ...(punchIn ? { requestedPunchIn: istTimeToIso(day.workDate, punchIn) } : {}),
        ...(punchOut ? { requestedPunchOut: istTimeToIso(day.workDate, punchOut) } : {}),
        reason: reason.trim(),
      });
      close();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={Boolean(day)}
      title="Ask for this day to be corrected"
      description={day ? formatDate(day.workDate) : undefined}
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

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Punch in (IST)"
            type="time"
            value={punchIn}
            error={fieldErrors.requestedPunchIn}
            onChange={(event) => setPunchIn(event.target.value)}
          />
          <Field
            label="Punch out (IST)"
            type="time"
            value={punchOut}
            error={fieldErrors.requestedPunchOut}
            onChange={(event) => setPunchOut(event.target.value)}
          />
        </div>

        <TextArea
          label="What happened?"
          rows={3}
          required
          value={reason}
          error={fieldErrors.reason}
          hint="Your approver has nothing else to go on, so be specific."
          onChange={(event) => setReason(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={request.isPending}
            disabled={reason.trim().length < 10 || (!punchIn && !punchOut)}
          >
            Send for approval
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- daily log */

function DailyLogTab() {
  // Mine, not my project's — a lead teaches as well as leading.
  const logs = useDailyLogs({ mine: true });
  const add = useAddDailyLog();
  const [workDate, setWorkDate] = useState(istToday());
  const [topic, setTopic] = useState('');
  const [hours, setHours] = useState('3');
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit() {
    setProblem(null);
    setFieldErrors({});
    try {
      await add.mutateAsync({
        workDate,
        topic: topic.trim(),
        hours: Number(hours),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setTopic('');
      setNotes('');
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <div className="space-y-6">
      <Card
        title="Record a session"
        description="Locked as soon as you save it. An administrator can unlock one if it needs correcting."
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
              label="Date"
              type="date"
              max={istToday()}
              value={workDate}
              error={fieldErrors.workDate}
              onChange={(event) => setWorkDate(event.target.value)}
            />
            <div className="sm:col-span-2">
              <Field
                label="Topic"
                required
                value={topic}
                error={fieldErrors.topic}
                placeholder="State, effects and the rules of hooks"
                onChange={(event) => setTopic(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Hours"
              type="number"
              min="0.5"
              max="12"
              step="0.5"
              value={hours}
              error={fieldErrors.hours}
              onChange={(event) => setHours(event.target.value)}
            />
            <div className="sm:col-span-2">
              <TextArea
                label="Notes"
                rows={2}
                value={notes}
                hint="Attendance in the room, what worked, what to revisit."
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={() => void submit()}
              pending={add.isPending}
              disabled={topic.trim().length < 3}
            >
              Save session
            </Button>
          </div>
        </div>
      </Card>

      {logs.isPending ? (
        <LoadingState label="Loading your sessions" rows={4} />
      ) : logs.isError ? (
        <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
      ) : logs.data.data.length === 0 ? (
        <EmptyState
          title="No sessions recorded yet"
          description="Sessions you save appear here, newest first."
        />
      ) : (
        <Table
          caption="Your recorded sessions"
          head={
            <>
              <Th>Date</Th>
              <Th>Session</Th>
              <Th>Topic</Th>
              <Th>Hours</Th>
              <Th>State</Th>
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
              <Td>
                <Badge tone={log.locked ? 'neutral' : 'pending'}>
                  {log.locked ? 'Locked' : 'Open for editing'}
                </Badge>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ deliverables */

function DeliverablesTab() {
  const deliverables = useDeliverables({ mine: true });

  if (deliverables.isPending) return <LoadingState label="Loading your deliverables" rows={4} />;
  if (deliverables.isError) {
    return <ErrorState error={deliverables.error} onRetry={() => void deliverables.refetch()} />;
  }

  const rows = deliverables.data.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing assigned yet"
        description="Syllabus items and other duties set for your project appear here."
      />
    );
  }

  const syllabus = rows.filter((row) => row.type === 'syllabus');
  const duties = rows.filter((row) => row.type === 'other_duty');

  return (
    <div className="space-y-6">
      {syllabus.length > 0 ? <DeliverableList title="Syllabus" rows={syllabus} /> : null}
      {duties.length > 0 ? <DeliverableList title="Other duties" rows={duties} /> : null}
    </div>
  );
}

export function DeliverableList({
  title,
  rows,
  readOnly = false,
}: {
  title: string;
  rows: DeliverableRow[];
  readOnly?: boolean;
}) {
  const done = rows.filter((row) => row.status === 'completed').length;

  return (
    <Card title={title} description={`${done} of ${rows.length} complete`}>
      <ul className="space-y-3">
        {rows.map((row) => (
          <DeliverableItem key={row.id} row={row} readOnly={readOnly} />
        ))}
      </ul>
    </Card>
  );
}

function DeliverableItem({ row, readOnly }: { row: DeliverableRow; readOnly: boolean }) {
  const update = useUpdateDeliverable();
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function move(status: DeliverableRow['status']) {
    setProblem(null);
    try {
      await update.mutateAsync({ id: row.id, status });
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  async function attach(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    setUploading(true);
    try {
      const fileId = await uploadFile(file, 'deliverable');
      await update.mutateAsync({ id: row.id, fileId });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  return (
    <li className="rounded-lg border border-line bg-surface p-4 sm:flex sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{row.title}</span>
          <Badge
            tone={
              row.status === 'completed'
                ? 'positive'
                : row.status === 'in_progress'
                  ? 'pending'
                  : 'neutral'
            }
          >
            {humanise(row.status)}
          </Badge>
        </div>
        {row.description ? <p className="mt-1 text-xs text-ink-soft">{row.description}</p> : null}
        <p className="mt-1 text-xs text-ink-faint">
          {row.dueDate ? `Due ${formatDate(row.dueDate)}` : 'No due date'}
          {row.completedAt ? ` · completed ${formatDate(row.completedAt)}` : ''}
        </p>
        {problem ? (
          <p role="alert" className="mt-1 text-xs font-medium text-danger">
            {problem}
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex shrink-0 flex-wrap gap-2 sm:mt-0">
        {row.fileId ? (
          <Button variant="secondary" onClick={() => void openResume(row.fileId!)}>
            View file
          </Button>
        ) : null}

        {readOnly ? null : (
          <>
            <label className="cursor-pointer">
              <input
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.ppt,.pptx,.xlsx"
                onChange={(event) => void attach(event.target.files?.[0])}
              />
              <span className="inline-flex items-center rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunk">
                {uploading ? 'Uploading…' : row.fileId ? 'Replace file' : 'Attach file'}
              </span>
            </label>

            {row.status !== 'completed' ? (
              <Button onClick={() => void move('completed')} pending={update.isPending}>
                Mark complete
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => void move('in_progress')}>
                Reopen
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/* --------------------------------------------------------------- resources */

function ResourcesTab() {
  const issues = useMyAssets();

  if (issues.isPending) return <LoadingState label="Loading your resources" rows={3} />;
  if (issues.isError) {
    return <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />;
  }
  if (issues.data.length === 0) {
    return (
      <EmptyState
        title="Nothing issued to you"
        description="Hardware and accounts issued for your project appear here with their serial numbers."
      />
    );
  }

  return (
    <Table
      caption="Issued to you"
      head={
        <>
          <Th>Item</Th>
          <Th>Serial</Th>
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
          <Td className="tabular-nums text-ink-soft">
            {issue.issueSerial ?? <span className="text-ink-faint">No serial</span>}
          </Td>
          <Td className="whitespace-nowrap text-ink-soft tabular-nums">
            {formatDate(issue.issuedAt)}
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
            {issue.returnedAt ? (
              <div className="mt-0.5 text-xs text-ink-soft">
                Returned {formatDate(issue.returnedAt)}
              </div>
            ) : null}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

/* ----------------------------------------------------------------- helpers */

function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return shifted.toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** An `HH:MM` typed in IST, on a given work date, as an absolute instant. */
function istTimeToIso(workDate: string, clock: string): string {
  return new Date(new Date(`${workDate}T${clock}:00.000Z`).getTime() - 330 * 60_000).toISOString();
}
