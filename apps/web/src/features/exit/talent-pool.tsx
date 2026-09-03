import { useState } from 'react';
import type { PoolEntry, PoolSource } from '@managedops/shared';
import {
  Badge,
  Button,
  Field,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
} from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../auth/auth-context';
import { formatDate, humanise } from '../onboarding/format';
import { openResume, usePositions } from '../onboarding/api';
import { downloadCsv, useConsiderForPosition, usePool } from './api';

/**
 * Everyone worth calling again.
 *
 * The pool is a query rather than a list somebody maintains (spec 15.2), so
 * every row here is a fact that is true right now: a candidate whose
 * conversation ended without a hire and who is happy to be contacted, or a past
 * trainer we would take back. Nobody adds or removes anybody; changing the
 * underlying fact changes the pool.
 */
export function TalentPoolPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<PoolSource | ''>('');
  const [workedBefore, setWorkedBefore] = useState<'' | 'true' | 'false'>('');
  const [considering, setConsidering] = useState<PoolEntry | null>(null);

  const pool = usePool({
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(source ? { source } : {}),
    ...(workedBefore ? { workedBefore: workedBefore === 'true' } : {}),
  });

  return (
    <>
      <PageHeader
        title="Talent Pool"
        description="People we have spoken to or worked with, and would speak to again."
        actions={
          <Button
            variant="secondary"
            onClick={() => void downloadCsv('/pool/export.csv', 'managedops-talent-pool.csv')}
          >
            Export CSV
          </Button>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Field
          label="Search"
          placeholder="Name, email, phone or employee code"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          label="Where they came from"
          value={source}
          onChange={(event) => setSource(event.target.value as PoolSource | '')}
        >
          <option value="">Everyone</option>
          <option value="candidate">Candidates we did not hire</option>
          <option value="past_trainer">Trainers who have left</option>
        </Select>
        <Select
          label="Worked with us"
          value={workedBefore}
          onChange={(event) => setWorkedBefore(event.target.value as '' | 'true' | 'false')}
        >
          <option value="">Either</option>
          <option value="true">Has worked here</option>
          <option value="false">Never worked here</option>
        </Select>
      </div>

      {pool.isPending ? (
        <LoadingState label="Loading the pool" rows={5} />
      ) : pool.isError ? (
        <ErrorState error={pool.error} onRetry={() => void pool.refetch()} />
      ) : pool.data.data.length === 0 ? (
        <EmptyState
          title="Nobody matches"
          description="The pool fills as candidates are screened out and trainers finish their assignments."
        />
      ) : (
        <Table
          caption="Talent pool"
          head={
            <>
              <Th>Name</Th>
              <Th>Contact</Th>
              <Th>Last seen</Th>
              <Th>How it ended</Th>
              <Th className="text-right">Rated</Th>
              <Th className="text-right">Action</Th>
            </>
          }
        >
          {pool.data.data.map((entry) => (
            <tr key={`${entry.source}-${entry.id}`}>
              <Td>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{entry.name}</span>
                  {entry.workedBefore ? <Badge tone="positive">Worked here</Badge> : null}
                </div>
                {entry.employeeCode ? (
                  <div className="mt-0.5 text-xs tabular-nums text-ink-soft">
                    {entry.employeeCode}
                  </div>
                ) : null}
              </Td>
              <Td className="text-ink-soft">
                <div>{entry.email}</div>
                <div className="text-xs tabular-nums">{entry.phone}</div>
              </Td>
              <Td className="whitespace-nowrap text-ink-soft">
                <div className="tabular-nums">{formatDate(entry.lastSeenAt)}</div>
                <div className="text-xs">
                  {entry.lastProject?.name ?? entry.lastPosition?.title ?? '—'}
                </div>
              </Td>
              <Td>
                <Badge tone={entry.source === 'past_trainer' ? 'neutral' : 'pending'}>
                  {humanise(entry.lastStatus)}
                </Badge>
                {entry.lastReason ? (
                  <div className="mt-0.5 max-w-xs text-xs text-ink-soft">{entry.lastReason}</div>
                ) : null}
              </Td>
              <Td className="text-right whitespace-nowrap">
                <PoolRating quality={entry.quality} />
              </Td>
              <Td className="text-right whitespace-nowrap">
                <div className="flex justify-end gap-2">
                  {entry.resumeFileId ? (
                    <Button
                      variant="secondary"
                      onClick={() => void openResume(entry.resumeFileId!)}
                    >
                      Résumé
                    </Button>
                  ) : null}
                  {can('pool.manage') ? (
                    <Button onClick={() => setConsidering(entry)}>Consider</Button>
                  ) : null}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <ConsiderDialog entry={considering} onClose={() => setConsidering(null)} />
    </>
  );
}

function ConsiderDialog({ entry, onClose }: { entry: PoolEntry | null; onClose: () => void }) {
  const positions = usePositions();
  const [positionId, setPositionId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const consider = useConsiderForPosition();

  const open = (positions.data?.data ?? []).filter((position) => position.status === 'open');

  function close() {
    setPositionId('');
    setProblem(null);
    setDone(false);
    onClose();
  }

  async function submit() {
    if (!entry || !positionId) return;
    setProblem(null);
    try {
      await consider.mutateAsync({ entryId: entry.id, positionId });
      setDone(true);
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={Boolean(entry)}
      title={entry ? `Consider ${entry.name}` : 'Consider'}
      description="This creates an application, subject to the same rules as any other."
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

        {done ? (
          <div className="rounded-md border border-primary/30 bg-primary-wash px-3 py-2 text-sm">
            <p className="font-medium text-primary">Application created.</p>
            <p className="mt-0.5 text-ink">
              They are in the pipeline now, and out of the pool until it closes again.
            </p>
          </div>
        ) : positions.isPending ? (
          <LoadingState label="Loading open positions" rows={1} />
        ) : open.length === 0 ? (
          <EmptyState
            title="No open positions"
            description="Open a position first, then come back and put them forward for it."
          />
        ) : (
          <Select
            label="Put them forward for"
            value={positionId}
            onChange={(event) => setPositionId(event.target.value)}
          >
            <option value="">Choose a position…</option>
            {open.map((position) => (
              <option key={position.id} value={position.id}>
                {position.title} — {position.project?.name ?? 'no project'}
              </option>
            ))}
          </Select>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {done ? null : (
            <Button
              onClick={() => void submit()}
              pending={consider.isPending}
              disabled={!positionId}
            >
              Create application
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * How a past trainer was rated, in a column's worth of space.
 *
 * A candidate has never delivered anything, so there is nothing to have rated
 * — which is a different statement from a low score and is said differently.
 * A figure the summary is not confident in is marked, because "5.0" from one
 * review is exactly the number somebody would act on and should not.
 */
function PoolRating({ quality }: { quality: PoolEntry['quality'] }) {
  if (!quality || quality.overall == null) {
    return <span className="text-xs text-ink-faint">Not rated</span>;
  }

  return (
    <div>
      <span
        className={`font-medium tabular-nums ${quality.confident ? 'text-ink' : 'text-ink-soft'}`}
      >
        {quality.overall}
        <span className="text-xs font-normal text-ink-soft"> / 5</span>
      </span>
      <div className="text-xs text-ink-soft">
        {quality.confident
          ? `${quality.respondentCount} ${quality.respondentCount === 1 ? 'person' : 'people'}`
          : 'too few to judge'}
      </div>
    </div>
  );
}
