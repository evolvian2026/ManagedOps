import { useRef, useState } from 'react';
import type { DocumentProgress, TrainerDocumentType } from '@managedops/shared';
import { ApiError, errorMessage } from '../../lib/api';
import { Badge, Button, Field, Modal, TextArea } from '../../components/ui';
import { openResume } from '../onboarding/api';
import { formatDate } from '../onboarding/format';
import { uploadFile, useUploadDocument, useVerifyDocument, type TrainerDocumentRow } from './api';

const LABELS: Record<string, string> = {
  aadhaar: 'Aadhaar',
  pan: 'PAN',
  education_certificate: 'Education certificate',
  experience_certificate: 'Experience certificate',
  photo: 'Photograph',
};

/** Aadhaar and PAN identifiers are never stored in full (spec 15.16). */
const NEEDS_LAST_FOUR = new Set(['aadhaar', 'pan']);

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
                  {LABELS[document.docType] ?? document.docType}
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
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const upload = useUploadDocument(trainerId);

  async function send(file: File, fourChars?: string) {
    setPending(true);
    setProblem(null);
    try {
      const fileId = await uploadFile(
        file,
        docType === 'aadhaar' || docType === 'pan' ? 'identity_document' : 'certificate',
      );
      await upload.mutateAsync({ docType, fileId, ...(fourChars ? { lastFour: fourChars } : {}) });
      setPendingFile(null);
      setLastFour('');
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
    if (NEEDS_LAST_FOUR.has(docType)) {
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
        title={`Upload your ${LABELS[docType] ?? docType}`}
        description="We store the document itself and only the last four characters of the number."
        onClose={() => setPendingFile(null)}
      >
        <div className="space-y-5">
          <Field
            label="Last four characters"
            required
            maxLength={4}
            value={lastFour}
            hint="Enough to tell two documents apart. The full number is never stored."
            onChange={(event) => setLastFour(event.target.value.toUpperCase())}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPendingFile(null)}>
              Cancel
            </Button>
            <Button
              pending={pending}
              disabled={lastFour.length !== 4}
              onClick={() => pendingFile && void send(pendingFile, lastFour)}
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
      description={document ? (LABELS[document.docType] ?? document.docType) : undefined}
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
