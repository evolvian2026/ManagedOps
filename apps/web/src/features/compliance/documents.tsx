import { useState } from 'react';
import { documentLabel } from '@managedops/shared';
import { Badge, Button, PageHeader, Select, Table, Td, Th } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { formatDate } from '../onboarding/format';
import { openResume } from '../onboarding/api';
import { useExpiringDocuments, type ExpiringDocumentRow, type ExpiryState } from '../workforce/api';

const STATES: { value: ExpiryState | ''; label: string }[] = [
  { value: '', label: 'Everything needing attention' },
  { value: 'expired', label: 'Already expired' },
  { value: 'expiring_soon', label: 'Expiring within a month' },
  { value: 'missing_date', label: 'No expiry recorded' },
];

/**
 * The documents that have lapsed or are about to.
 *
 * Only the types that actually expire appear here — a degree certificate does
 * not stop being true. The list is what a client asks for before somebody sets
 * foot on their site, so an expired police verification and one nobody put a
 * date against are both on it: they are equally useless as evidence.
 */
export function DocumentCompliancePage() {
  const [state, setState] = useState<ExpiryState | ''>('');
  const documents = useExpiringDocuments(state);

  const rows = documents.data?.data ?? [];
  const expired = rows.filter((row) => row.validity.state === 'expired').length;

  return (
    <>
      <PageHeader
        title="Document Compliance"
        description="Police verifications and medical certificates that have lapsed, or are about to."
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Select
          label="Show"
          value={state}
          onChange={(event) => setState(event.target.value as ExpiryState | '')}
        >
          {STATES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      {expired > 0 ? (
        <div className="mb-5 rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm">
          <p className="font-medium text-ink">
            {expired} document{expired === 1 ? ' has' : 's have'} already expired.
          </p>
          <p className="mt-0.5 text-ink-soft">
            An expired police verification is worth the same as none. A client may refuse the
            trainer access to site until it is renewed.
          </p>
        </div>
      ) : null}

      {documents.isPending ? (
        <LoadingState label="Loading documents" rows={4} />
      ) : documents.isError ? (
        <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing lapsing"
          description="Every document that expires is current and dated."
        />
      ) : (
        <Table
          caption="Documents expiring"
          head={
            <>
              <Th>Trainer</Th>
              <Th>Document</Th>
              <Th>Expires</Th>
              <Th>State</Th>
              <Th className="text-right">Document</Th>
            </>
          }
        >
          {rows.map((row) => (
            <ExpiryRow key={row.id} row={row} />
          ))}
        </Table>
      )}
    </>
  );
}

function ExpiryRow({ row }: { row: ExpiringDocumentRow }) {
  const tone =
    row.validity.state === 'expired'
      ? 'critical'
      : row.validity.state === 'missing_date'
        ? 'pending'
        : 'neutral';

  return (
    <tr>
      <Td>
        <div className="font-medium text-ink">{row.trainer.name}</div>
        <div className="mt-0.5 font-mono text-xs text-ink-soft">{row.trainer.employeeCode}</div>
        {row.trainer.projects.length > 0 ? (
          <div className="mt-0.5 text-xs text-ink-faint">{row.trainer.projects.join(', ')}</div>
        ) : null}
      </Td>
      <Td className="text-ink">{documentLabel(row.docType, { capitalise: true })}</Td>
      <Td className="whitespace-nowrap tabular-nums text-ink-soft">
        {row.expiresOn ? formatDate(row.expiresOn) : <span className="text-ink-faint">—</span>}
      </Td>
      <Td>
        <Badge tone={tone}>
          {row.validity.state === 'expired'
            ? 'Expired'
            : row.validity.state === 'missing_date'
              ? 'No date'
              : 'Expiring soon'}
        </Badge>
        {row.validity.message ? (
          <div className="mt-0.5 max-w-xs text-xs text-ink-soft">{row.validity.message}</div>
        ) : null}
      </Td>
      <Td className="text-right">
        {row.fileId ? (
          <Button variant="secondary" onClick={() => void openResume(row.fileId!)}>
            Open
          </Button>
        ) : row.hasFile ? (
          // Uploaded, but not this caller's to read — the same rule the
          // checklist follows, said the same way.
          <span className="text-xs text-ink-faint">On file</span>
        ) : (
          <span className="text-xs text-ink-faint">Nothing uploaded</span>
        )}
      </Td>
    </tr>
  );
}
