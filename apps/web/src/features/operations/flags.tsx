import { useState } from 'react';
import { FLAG_ACTIONS, type FlagAction, type FlagSeverity } from '@managedops/shared';
import {
  Badge,
  Button,
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
import { formatDate, humanise } from '../onboarding/format';
import { useFlags, useRaiseFlag, useResolveFlag, type FlagRow } from './api';

const SEVERITY_TONE: Record<FlagSeverity, 'neutral' | 'pending' | 'critical'> = {
  low: 'neutral',
  medium: 'pending',
  high: 'critical',
};

/**
 * The flag queue: concerns raised against a trainer, and what was done.
 *
 * Nobody chooses who to send a flag to (spec 15.5) — the project's Manager and
 * HR are notified automatically. Closing one requires both an action and a note,
 * because "closed" with neither is what makes the record untrustworthy a year
 * later when somebody asks what actually happened.
 */
export function FlagsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'open' | 'all'>('open');
  const flags = useFlags(tab === 'open' ? { open: true } : {});

  return (
    <>
      <PageHeader
        title="Flags"
        description="Concerns raised on your projects, and the action taken on each."
      />

      <Tabs
        label="Flags"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'open', label: 'Open', count: tab === 'open' ? flags.data?.meta.total : undefined },
          { id: 'all', label: 'All history' },
        ]}
      />

      <div className="mt-6">
        {flags.isPending ? (
          <LoadingState label="Loading flags" rows={3} />
        ) : flags.isError ? (
          <ErrorState error={flags.error} onRetry={() => void flags.refetch()} />
        ) : flags.data.data.length === 0 ? (
          <EmptyState
            title={tab === 'open' ? 'Nothing open' : 'No flags raised'}
            description={
              tab === 'open'
                ? 'Concerns still waiting on an outcome appear here.'
                : 'A project lead raises a flag from a trainer’s profile.'
            }
          />
        ) : (
          <FlagTable rows={flags.data.data} canResolve={can('flags.resolve')} />
        )}
      </div>
    </>
  );
}

function FlagTable({ rows, canResolve }: { rows: FlagRow[]; canResolve: boolean }) {
  const [resolving, setResolving] = useState<FlagRow | null>(null);

  return (
    <>
      <Table
        caption="Flags"
        head={
          <>
            <Th>Trainer</Th>
            <Th>Severity</Th>
            <Th>Concern</Th>
            <Th>Raised</Th>
            <Th>Outcome</Th>
            <Th className="text-right">Action</Th>
          </>
        }
      >
        {rows.map((row) => (
          <tr key={row.id}>
            <Td>
              <div className="font-medium text-ink">{row.assignment.trainer.user.name}</div>
              <div className="text-xs text-ink-soft">{row.assignment.project.name}</div>
            </Td>
            <Td>
              <Badge tone={SEVERITY_TONE[row.severity]}>{humanise(row.severity)}</Badge>
            </Td>
            <Td className="text-ink-soft">{row.description}</Td>
            <Td className="whitespace-nowrap text-xs text-ink-soft tabular-nums">
              {formatDate(row.createdAt)}
              <div>by {row.raisedBy.name}</div>
            </Td>
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
            <Td className="text-right">
              {canResolve && row.status !== 'closed' ? (
                <Button onClick={() => setResolving(row)}>Record outcome</Button>
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>

      <ResolveDialog flag={resolving} onClose={() => setResolving(null)} />
    </>
  );
}

function ResolveDialog({ flag, onClose }: { flag: FlagRow | null; onClose: () => void }) {
  const [actionTaken, setActionTaken] = useState<FlagAction>('warning');
  const [resolutionNote, setResolutionNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const resolve = useResolveFlag();

  function close() {
    setResolutionNote('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function submit() {
    if (!flag) return;
    setProblem(null);
    setFieldErrors({});
    try {
      await resolve.mutateAsync({
        flagId: flag.id,
        actionTaken,
        resolutionNote: resolutionNote.trim(),
      });
      close();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={Boolean(flag)}
      title="Record what was done"
      description={flag ? `${flag.assignment.trainer.user.name} — ${flag.description}` : undefined}
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

        <Select
          label="Action taken"
          value={actionTaken}
          error={fieldErrors.actionTaken}
          onChange={(event) => setActionTaken(event.target.value as FlagAction)}
        >
          {FLAG_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {humanise(action)}
            </option>
          ))}
        </Select>

        <TextArea
          label="What happened?"
          rows={3}
          required
          value={resolutionNote}
          error={fieldErrors.resolutionNote}
          hint="The person who raised this sees your answer, so say enough to close the loop."
          onChange={(event) => setResolutionNote(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={resolve.isPending}
            disabled={resolutionNote.trim().length < 5}
          >
            Close this flag
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Raising a flag, from a trainer's profile on the roster. */
export function RaiseFlagDialog({
  assignmentId,
  trainerName,
  open,
  onClose,
}: {
  assignmentId: string;
  trainerName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [severity, setSeverity] = useState<FlagSeverity>('medium');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const raise = useRaiseFlag();

  function close() {
    setDescription('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function submit() {
    setProblem(null);
    setFieldErrors({});
    try {
      await raise.mutateAsync({ assignmentId, severity, description: description.trim() });
      close();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={open}
      title={`Raise a concern about ${trainerName}`}
      description="The project’s manager and HR are notified automatically."
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

        <Select
          label="Severity"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as FlagSeverity)}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>

        <TextArea
          label="What is the concern?"
          rows={4}
          required
          value={description}
          error={fieldErrors.description}
          hint="Be specific about what happened and when — this is what the manager acts on."
          onChange={(event) => setDescription(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={raise.isPending}
            disabled={description.trim().length < 10}
          >
            Raise flag
          </Button>
        </div>
      </div>
    </Modal>
  );
}
