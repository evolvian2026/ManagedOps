import { useState } from 'react';
import { Badge, Button, Card, Modal } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { formatIst, humanise } from '../onboarding/format';
import { currentPosition, usePunch, useToday, type PunchInput } from './api';
import { LoadingState, ErrorState } from '../../components/states';

/**
 * The punch card: one large action, and when there is no action, the reason.
 *
 * A disabled button with no explanation is the thing this deliberately avoids.
 * "Today is a project holiday" and "You are on approved leave today" are
 * answers; a greyed-out control is not.
 */
export function PunchCard() {
  const today = useToday();
  const punchIn = usePunch('in');
  const punchOut = usePunch('out');
  const [problem, setProblem] = useState<string | null>(null);
  const [consenting, setConsenting] = useState(false);

  if (today.isPending) return <LoadingState label="Loading today" rows={2} />;
  if (today.isError) {
    return <ErrorState error={today.error} onRetry={() => void today.refetch()} />;
  }

  const state = today.data;
  const pending = punchIn.isPending || punchOut.isPending;

  async function punch(direction: 'in' | 'out', locationConsent?: boolean) {
    setProblem(null);
    setConsenting(false);
    // Asked for, never required: a refusal still produces a valid punch.
    const position = await currentPosition();
    const input: PunchInput = {
      ...(position ?? {}),
      ...(locationConsent ? { locationConsent } : {}),
    };

    try {
      await (direction === 'in' ? punchIn : punchOut).mutateAsync(input);
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  function start() {
    // The consent notice is shown once, before the first punch of their
    // working life, and the acceptance is what gets recorded (spec 4.5).
    if (!state.locationConsentGiven) setConsenting(true);
    else void punch('in');
  }

  return (
    <Card>
      <div className="sm:flex sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-ink-faint">
            {state.assignment.projectName}
          </p>
          <h2 className="mt-1 text-lg font-semibold text-ink">
            {new Date(`${state.workDate}T00:00:00Z`).toLocaleDateString('en-IN', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </h2>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            {state.attendance ? (
              <Badge tone={toneFor(state.attendance.status)}>
                {humanise(state.attendance.status)}
              </Badge>
            ) : (
              <Badge tone="neutral">Not started</Badge>
            )}
            <span className="text-ink-soft">
              Day starts {state.assignment.workStartTime} IST, {state.assignment.graceMinutes}{' '}
              minutes grace
            </span>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <dt className="text-ink-soft">Punched in</dt>
            <dd className="tabular-nums text-ink">
              {state.attendance?.punchInAt ? formatIst(state.attendance.punchInAt) : '—'}
            </dd>
            <dt className="text-ink-soft">Punched out</dt>
            <dd className="tabular-nums text-ink">
              {state.attendance?.punchOutAt ? formatIst(state.attendance.punchOutAt) : '—'}
            </dd>
          </dl>

          {state.reason ? <p className="mt-3 text-sm text-ink-soft">{state.reason}</p> : null}
        </div>

        <div className="mt-5 shrink-0 sm:mt-0">
          {state.action === 'punch_in' ? (
            <Button
              onClick={start}
              pending={pending}
              className="w-full px-8 py-3 text-base sm:w-auto"
            >
              Punch in
            </Button>
          ) : state.action === 'punch_out' ? (
            <Button
              onClick={() => void punch('out')}
              pending={pending}
              className="w-full px-8 py-3 text-base sm:w-auto"
            >
              Punch out
            </Button>
          ) : (
            <p className="rounded-md border border-line bg-canvas px-4 py-3 text-sm text-ink-soft">
              {state.action === 'done' ? 'Your day is recorded.' : 'Nothing to record today.'}
            </p>
          )}
        </div>
      </div>

      {problem ? (
        <p role="alert" className="mt-4 text-sm font-medium text-danger">
          {problem}
        </p>
      ) : null}

      <Modal
        open={consenting}
        title="Punches record where you are"
        description="Once, before your first punch."
        onClose={() => setConsenting(false)}
      >
        <div className="space-y-5 text-sm text-ink">
          <p>
            When you punch in or out, ManagedOps records the coordinates your browser reports,
            alongside the time. It is kept as part of the attendance record and is visible to your
            project lead, the project manager and HR.
          </p>
          <p className="text-ink-soft">
            There is no geofence: if you decline the browser permission, or it is unavailable, your
            punch still succeeds and the record simply says the location was unavailable.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConsenting(false)}>
              Not now
            </Button>
            <Button onClick={() => void punch('in', true)} pending={pending}>
              I understand — punch in
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

export function toneFor(status: string): 'neutral' | 'positive' | 'pending' | 'critical' {
  switch (status) {
    case 'present':
    case 'corrected':
      return 'positive';
    case 'late':
    case 'correction_pending':
    case 'missing_punch_out':
      return 'pending';
    case 'absent':
      return 'critical';
    default:
      return 'neutral';
  }
}
