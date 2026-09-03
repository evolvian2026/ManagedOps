import { useRef, useState } from 'react';
import {
  EXPIRING_DOCUMENT_TYPES,
  defaultExpiryFor,
  documentLabel,
  type DocumentProgress,
  type TrainerDocumentType,
} from '@managedops/shared';
import { ApiError, errorMessage } from '../../lib/api';
import { Badge, Button, Field, Modal, TextArea } from '../../components/ui';
import { openResume } from '../onboarding/api';
import { formatDate } from '../onboarding/format';
import { uploadFile, useUploadDocument, useVerifyDocument, type TrainerDocumentRow } from './api';

/** Aadhaar and PAN identifiers are never stored in full (spec 15.16). */
const NEEDS_LAST_FOUR = new Set(['aadhaar', 'pan']);

/** The types that lapse, which cannot be filed without saying when. */
const NEEDS_EXPIRY = new Set<string>(EXPIRING_DOCUMENT_TYPES);

const STATUS_TONE: Record<string, 'neutral' | 'positive' | 'pending' | 'critical'> = {
  pending: 'pending',
  verified: 'positive',
  rejected: 'critical',
};

/**
 * The onboarding checklist, shared by HR's view of a trainer and the trainer's
 * own profile. `canVerify` and `canUpload` decide which actions appear, so one
 * component serves both without pretending the two roles are the same.
 */
export function DocumentChecklist({
  trainerId,
  documents,
  progress,
  canVerify,
  canUpload,
}: {
  trainerId: string;
  documents: TrainerDocumentRow[];
  progress: DocumentProgress;
  canVerify: boolean;
  canUpload: boolean;
}) {
  const [rejecting, setRejecting] = useState<TrainerDocumentRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const verify = useVerifyDocument(trainerId);

  async function approve(document: TrainerDocumentRow) {
    setProblem(null);
    try {
      await verify.mutateAsync({ documentId: document.id, decision: 'verified' });
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <div className="space-y-4">
      <ProgressBanner progress={progress} />

      {problem ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
        >
          {problem}
        </div>
      ) : null}

      <ul className="space-y-3">
        {documents.map((document) => (
          <li
            key={document.id}
            className="rounded-lg border border-line bg-surface p-4 sm:flex sm:items-start sm:justify-between sm:gap-4"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">
                  {documentLabel(document.docType, { capitalise: true })}
                </span>
                <Badge tone={STATUS_TONE[document.status] ?? 'neutral'}>
                  {document.status === 'pending' && !document.hasFile
                    ? 'Not uploaded'
                    : document.status === 'pending'
                      ? 'Awaiting verification'
                      : document.status === 'verified'
                        ? 'Verified'
                        : 'Rejected'}
                </Badge>
                {document.mandatory === false ? (
                  <span className="text-xs text-ink-faint">Optional</span>
                ) : null}
              </div>

              <div className="mt-1 space-y-0.5 text-xs text-ink-soft">
                {document.lastFour ? (
                  <p className="tabular-nums">Ends in {document.lastFour}</p>
                ) : null}
                {document.validity.state !== 'not_applicable' ? (
                  <p
                    className={
                      document.validity.state === 'expired'
                        ? 'font-medium text-danger'
                        : document.validity.state === 'valid'
                          ? 'text-ink-soft'
                          : 'font-medium text-accent'
                    }
                  >
                    {document.expiresOn ? `Expires ${formatDate(document.expiresOn)}` : null}
                    {document.validity.message
                      ? `${document.expiresOn ? ' · ' : ''}${document.validity.message}`
                      : null}
                  </p>
                ) : null}
                {document.verifiedAt && document.verifiedBy ? (
                  <p>
                    {document.status === 'verified' ? 'Verified' : 'Reviewed'} by{' '}
                    {document.verifiedBy.name} on {formatDate(document.verifiedAt)}
                  </p>
                ) : null}
                {document.rejectReason ? (
                  <p className="font-medium text-danger">{document.rejectReason}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-3 flex shrink-0 flex-wrap gap-2 sm:mt-0">
              {document.fileId ? (
                <Button variant="secondary" onClick={() => void openResume(document.fileId!)}>
                  View
                </Button>
              ) : null}

              {canUpload && document.status !== 'verified' ? (
                <UploadButton trainerId={trainerId} docType={document.docType} />
              ) : null}

              {canVerify && document.hasFile && document.status !== 'verified' ? (
                <>
                  <Button variant="secondary" onClick={() => setRejecting(document)}>
                    Reject
                  </Button>
                  <Button onClick={() => void approve(document)} pending={verify.isPending}>
                    Verify
                  </Button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <RejectDialog trainerId={trainerId} document={rejecting} onClose={() => setRejecting(null)} />
    </div>
  );
}

function ProgressBanner({ progress }: { progress: DocumentProgress }) {
  if (progress.complete) {
    return (
      <div className="rounded-md border border-primary/30 bg-primary-wash px-4 py-3 text-sm">
        <p className="font-medium text-primary">Every document is in and verified.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-accent/30 bg-accent-wash px-4 py-3 text-sm">
      <p className="font-medium text-accent">
        {progress.verified} of {progress.required} documents verified
      </p>
      <p className="mt-0.5 text-ink">Still needed: {progress.missing.join(', ')}.</p>
      {/* A target with reminders, not a lock-out (spec 15.7). */}
      <p className="mt-1 text-xs text-ink-soft">
        You can keep using ManagedOps meanwhile — this is a reminder, not a restriction.
      </p>
    </div>
  );
}

function UploadButton({ trainerId, docType }: { trainerId: string; docType: TrainerDocumentType }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lastFour, setLastFour] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const upload = useUploadDocument(trainerId);

  async function send(file: File, fourChars?: string, expiry?: string) {
    setPending(true);
    setProblem(null);
    try {
      const fileId = await uploadFile(
        file,
        docType === 'aadhaar' || docType === 'pan' ? 'identity_document' : 'certificate',
      );
      await upload.mutateAsync({
        docType,
        fileId,
        ...(fourChars ? { lastFour: fourChars } : {}),
        ...(expiry ? { expiresOn: expiry } : {}),
      });
      setPendingFile(null);
      setLastFour('');
      setExpiresOn('');
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  function onPicked(file: File | undefined) {
    if (!file) return;
    // Aadhaar and PAN need their last four characters, so ask before uploading
    // rather than failing validation after the file has already gone up.
    if (NEEDS_LAST_FOUR.has(docType) || NEEDS_EXPIRY.has(docType)) {
      // Ask before the file goes up rather than failing validation after it has.
      if (NEEDS_EXPIRY.has(docType)) {
        setExpiresOn(defaultExpiryFor(docType, new Date().toISOString().slice(0, 10)) ?? '');
      }
      setPendingFile(file);
      return;
    }
    void send(file);
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png"
        onChange={(event) => onPicked(event.target.files?.[0])}
      />
      <Button variant="secondary" pending={pending} onClick={() => inputRef.current?.click()}>
        Upload
      </Button>

      {problem ? (
        <p role="alert" className="w-full text-xs font-medium text-danger">
          {problem}
        </p>
      ) : null}

      <Modal
        open={Boolean(pendingFile)}
        title={`Upload your ${documentLabel(docType)}`}
        description={
          NEEDS_EXPIRY.has(docType)
            ? 'This kind of document lapses, so we need to know when.'
            : 'We store the document itself and only the last four characters of the number.'
        }
        onClose={() => setPendingFile(null)}
      >
        <div className="space-y-5">
          {NEEDS_LAST_FOUR.has(docType) ? (
            <Field
              label="Last four characters"
              required
              maxLength={4}
              value={lastFour}
              hint="Enough to tell two documents apart. The full number is never stored."
              onChange={(event) => setLastFour(event.target.value.toUpperCase())}
            />
          ) : null}
          {NEEDS_EXPIRY.has(docType) ? (
            <Field
              label="Expires on"
              type="date"
              required
              value={expiresOn}
              hint="Taken from the certificate. Prefilled with the usual validity — correct it if yours differs."
              onChange={(event) => setExpiresOn(event.target.value)}
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPendingFile(null)}>
              Cancel
            </Button>
            <Button
              pending={pending}
              disabled={
                (NEEDS_LAST_FOUR.has(docType) && lastFour.length !== 4) ||
                (NEEDS_EXPIRY.has(docType) && !expiresOn)
              }
              onClick={() => pendingFile && void send(pendingFile, lastFour, expiresOn)}
            >
              Upload
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function RejectDialog({
  trainerId,
  document,
  onClose,
}: {
  trainerId: string;
  document: TrainerDocumentRow | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const verify = useVerifyDocument(trainerId);

  function close() {
    setReason('');
    setProblem(null);
    setFieldErrors({});
    onClose();
  }

  async function submit() {
    if (!document) return;
    setProblem(null);
    setFieldErrors({});
    try {
      await verify.mutateAsync({
        documentId: document.id,
        decision: 'rejected',
        rejectReason: reason.trim(),
      });
      close();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={Boolean(document)}
      title="Reject this document"
      description={document ? documentLabel(document.docType, { capitalise: true }) : undefined}
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

        <TextArea
          label="What is wrong with it?"
          rows={3}
          required
          value={reason}
          error={fieldErrors.rejectReason}
          hint="They see this, so say what to fix — a cut-off scan, the wrong document, unreadable."
          onChange={(event) => setReason(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={verify.isPending}>
            Reject and ask again
          </Button>
        </div>
      </div>
    </Modal>
  );
}
