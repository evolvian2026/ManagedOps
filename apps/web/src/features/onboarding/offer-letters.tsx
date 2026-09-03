import { useState } from 'react';
import type { OfferStatus } from '@managedops/shared';
import { ApiError, errorMessage } from '../../lib/api';
import { Badge, Button, Modal, Table, Td, TextArea, Th, Tabs } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { useOffers, useRespondToOffer, useSendOffer, type OfferRow } from './api';
import { STATUS_TONE, formatDate, formatInr, humanise } from './format';

type Tab = 'draft' | 'sent' | 'history';
type SentFilter = 'all' | 'accepted' | 'declined' | 'awaiting';

/**
 * Offer letters.
 *
 * The letter itself is sent out of band; ManagedOps records that it went and
 * what came back. Every revision is its own version, so the history tab is
 * simply every row rather than a separate archive that could fall out of step.
 */
export function OfferLetters() {
  const [tab, setTab] = useState<Tab>('sent');
  const [sentFilter, setSentFilter] = useState<SentFilter>('all');
  const [responding, setResponding] = useState<OfferRow | null>(null);

  const offers = useOffers();

  if (offers.isPending) return <LoadingState label="Loading offers" rows={3} />;
  if (offers.isError)
    return <ErrorState error={offers.error} onRetry={() => void offers.refetch()} />;

  const all = offers.data.data;
  const drafts = all.filter((offer) => offer.status === 'draft');
  const sent = all.filter((offer) =>
    ['sent', 'accepted', 'declined', 'revision_requested'].includes(offer.status),
  );

  const filteredSent = sent.filter((offer) => {
    if (sentFilter === 'accepted') return offer.status === 'accepted';
    if (sentFilter === 'declined') return offer.status === 'declined';
    if (sentFilter === 'awaiting') return offer.status === 'sent';
    return true;
  });

  return (
    <div className="space-y-4">
      <Tabs
        label="Offer stages"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'draft', label: 'Draft', count: drafts.length },
          { id: 'sent', label: 'Sent', count: sent.length },
          { id: 'history', label: 'All versions', count: all.length },
        ]}
      />

      {tab === 'sent' ? (
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['all', 'All'],
              ['awaiting', 'Awaiting a reply'],
              ['accepted', 'Accepted'],
              ['declined', 'Declined'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setSentFilter(value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                sentFilter === value
                  ? 'bg-primary text-white'
                  : 'border border-line-strong bg-surface text-ink-soft hover:bg-surface-sunk'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'draft' ? (
        <OfferTable
          rows={drafts}
          emptyTitle="No drafts"
          emptyDescription="An offer is drafted once a candidate is selected at interview."
          onRespond={setResponding}
        />
      ) : tab === 'sent' ? (
        <OfferTable
          rows={filteredSent}
          emptyTitle="Nothing here"
          emptyDescription="Offers appear here once they have been sent to a candidate."
          onRespond={setResponding}
        />
      ) : (
        <OfferTable
          rows={all}
          showVersion
          emptyTitle="No offers yet"
          emptyDescription="Every version of every offer will be listed here."
          onRespond={setResponding}
        />
      )}

      <RespondDialog offer={responding} onClose={() => setResponding(null)} />
    </div>
  );
}

function OfferTable({
  rows,
  emptyTitle,
  emptyDescription,
  showVersion = false,
  onRespond,
}: {
  rows: OfferRow[];
  emptyTitle: string;
  emptyDescription: string;
  showVersion?: boolean;
  onRespond: (offer: OfferRow) => void;
}) {
  const send = useSendOffer();
  const [problem, setProblem] = useState<string | null>(null);

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  async function sendOffer(offer: OfferRow) {
    setProblem(null);
    try {
      await send.mutateAsync({ id: offer.id });
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <div className="space-y-3">
      {problem ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
        >
          {problem}
        </div>
      ) : null}

      <Table
        caption="Offers"
        head={
          <>
            <Th>Candidate</Th>
            <Th>Position</Th>
            <Th>Salary</Th>
            <Th>Joining</Th>
            <Th>Status</Th>
            <Th>Responded</Th>
            <Th className="text-right">Action</Th>
          </>
        }
      >
        {rows.map((offer) => (
          <tr key={offer.id}>
            <Td>
              <div className="font-medium">{offer.application.candidate.name}</div>
              <div className="text-xs text-ink-soft">{offer.application.candidate.email}</div>
            </Td>
            <Td className="text-ink-soft">
              <div>{offer.application.position.title}</div>
              <div className="text-xs">
                {offer.application.position.project.name}
                {showVersion ? ` · version ${offer.version}` : ''}
              </div>
            </Td>
            <Td className="whitespace-nowrap tabular-nums">{formatInr(offer.salaryAnnual)}</Td>
            <Td className="whitespace-nowrap text-ink-soft tabular-nums">
              {formatDate(offer.joiningDate)}
            </Td>
            <Td>
              <Badge tone={STATUS_TONE[offer.status] ?? 'neutral'}>{humanise(offer.status)}</Badge>
            </Td>
            <Td className="whitespace-nowrap text-ink-soft tabular-nums">
              {formatDate(offer.respondedAt)}
            </Td>
            <Td className="text-right whitespace-nowrap">
              {offer.status === 'draft' ? (
                <Button onClick={() => void sendOffer(offer)} pending={send.isPending}>
                  Send
                </Button>
              ) : offer.status === 'sent' ? (
                <Button variant="secondary" onClick={() => onRespond(offer)}>
                  Record reply
                </Button>
              ) : (
                <span className="text-xs text-ink-faint">—</span>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function RespondDialog({ offer, onClose }: { offer: OfferRow | null; onClose: () => void }) {
  const [response, setResponse] = useState<'accepted' | 'declined' | 'revision_requested'>(
    'accepted',
  );
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const respond = useRespondToOffer();

  function close() {
    setResponse('accepted');
    setNotes('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function submit() {
    if (!offer) return;
    setProblem(null);
    setFieldErrors({});

    try {
      await respond.mutateAsync({
        id: offer.id,
        response,
        notes: notes.trim() || undefined,
      });
      close();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={Boolean(offer)}
      title="Record the candidate's reply"
      description={
        offer
          ? `${offer.application.candidate.name} — ${offer.application.position.title}`
          : undefined
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
          <legend className="mb-1 text-sm font-medium text-ink">What did they say?</legend>
          {(
            [
              ['accepted', 'Accepted', 'Hires them and consumes a seat on the position.'],
              ['declined', 'Declined', 'Closes the application and keeps them in the talent pool.'],
              [
                'revision_requested',
                'Asked for a revision',
                'Keeps the negotiation open so a new version can be drafted.',
              ],
            ] as const
          ).map(([value, label, consequence]) => (
            <label
              key={value}
              className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${
                response === value
                  ? 'border-primary bg-primary-wash/40'
                  : 'border-line hover:bg-surface-sunk'
              }`}
            >
              <input
                type="radio"
                name="offer-response"
                checked={response === value}
                onChange={() => setResponse(value)}
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
          label="Notes"
          rows={2}
          value={notes}
          error={fieldErrors.notes}
          placeholder={
            response === 'declined' ? 'Why did they decline?' : 'Anything worth recording'
          }
          onChange={(event) => setNotes(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={respond.isPending}>
            Record reply
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export type { OfferStatus };
