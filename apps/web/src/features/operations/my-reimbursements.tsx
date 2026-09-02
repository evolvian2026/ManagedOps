import { useRef, useState } from 'react';
import { REIMBURSEMENT_CATEGORIES, type ReimbursementCategory } from '@managedops/shared';
import {
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  TextArea,
} from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { ApiError, errorMessage } from '../../lib/api';
import { formatDate, formatInr, humanise } from '../onboarding/format';
import { openResume } from '../onboarding/api';
import { uploadFile } from '../workforce/api';
import { useReimbursements, useSubmitClaim, type ReimbursementRow } from './api';

export const CLAIM_TONE: Record<string, 'neutral' | 'positive' | 'pending' | 'critical'> = {
  submitted: 'pending',
  under_review: 'pending',
  approved: 'positive',
  rejected: 'critical',
  reimbursed: 'positive',
};

/**
 * Submitting a claim and following it to the money.
 *
 * The proof file is uploaded before the claim is created, because the API will
 * not accept a claim whose evidence has not finished uploading — asking for the
 * receipt first is the honest order to do it in.
 */
export function MyReimbursementsPage() {
  const claims = useReimbursements();

  return (
    <>
      <PageHeader
        title="My Reimbursements"
        description="Submit a claim with its receipt, and follow it through to payment."
      />

      <div className="space-y-6">
        <ClaimForm />

        {claims.isPending ? (
          <LoadingState label="Loading your claims" rows={3} />
        ) : claims.isError ? (
          <ErrorState error={claims.error} onRetry={() => void claims.refetch()} />
        ) : claims.data.data.length === 0 ? (
          <EmptyState
            title="No claims submitted"
            description="Expenses you claim appear here, with where each one has got to."
          />
        ) : (
          <ClaimTable rows={claims.data.data} />
        )}
      </div>
    </>
  );
}

function ClaimForm() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<ReimbursementCategory>('travel');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const submitClaim = useSubmitClaim();

  async function submit() {
    if (!proof) return;
    setProblem(null);
    setFieldErrors({});
    setUploading(true);
    try {
      const proofFileId = await uploadFile(proof, 'reimbursement_proof');
      await submitClaim.mutateAsync({
        category,
        amount: Number(amount),
        description: description.trim(),
        proofFileId,
      });
      setAmount('');
      setDescription('');
      setProof(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card
      title="Submit a claim"
      description="Claims above ₹10,000 need a manager's approval rather than HR's."
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
            label="Category"
            value={category}
            error={fieldErrors.category}
            onChange={(event) => setCategory(event.target.value as ReimbursementCategory)}
          >
            {REIMBURSEMENT_CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </Select>
          <Field
            label="Amount (₹)"
            type="number"
            min="1"
            step="1"
            required
            value={amount}
            error={fieldErrors.amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>

        <TextArea
          label="What was it for?"
          rows={2}
          required
          value={description}
          error={fieldErrors.description}
          onChange={(event) => setDescription(event.target.value)}
        />

        <div className="space-y-1.5">
          <label htmlFor="claim-proof" className="block text-sm font-medium text-ink">
            Receipt
          </label>
          <input
            ref={fileRef}
            id="claim-proof"
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium"
            onChange={(event) => setProof(event.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-ink-soft">
            Required — a claim without proof cannot be assessed. {fieldErrors.proofFileId ?? ''}
          </p>
        </div>

        <div className="flex justify-end">
          <Button
            onClick={() => void submit()}
            pending={uploading || submitClaim.isPending}
            disabled={!proof || !amount || description.trim().length < 5}
          >
            Submit claim
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ClaimTable({ rows }: { rows: ReimbursementRow[] }) {
  return (
    <Table
      caption="Your claims"
      head={
        <>
          <Th>Submitted</Th>
          <Th>Category</Th>
          <Th>Amount</Th>
          <Th>Description</Th>
          <Th>Status</Th>
          <Th className="text-right">Receipt</Th>
        </>
      }
    >
      {rows.map((row) => (
        <tr key={row.id}>
          <Td className="whitespace-nowrap tabular-nums">{formatDate(row.createdAt)}</Td>
          <Td className="text-ink-soft">{humanise(row.category)}</Td>
          <Td className="whitespace-nowrap tabular-nums font-medium">{formatInr(row.amount)}</Td>
          <Td className="text-ink-soft">
            <div>{row.description}</div>
            {row.reviewNote ? <div className="text-xs text-ink-faint">{row.reviewNote}</div> : null}
          </Td>
          <Td>
            <Badge tone={CLAIM_TONE[row.status] ?? 'neutral'}>{humanise(row.status)}</Badge>
            {row.paymentReference ? (
              <div className="mt-0.5 text-xs text-ink-soft tabular-nums">
                {row.paymentReference}
              </div>
            ) : null}
          </Td>
          <Td className="text-right">
            <Button variant="secondary" onClick={() => void openResume(row.proofFileId)}>
              View
            </Button>
          </Td>
        </tr>
      ))}
    </Table>
  );
}
