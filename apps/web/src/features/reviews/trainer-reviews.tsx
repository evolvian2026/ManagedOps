import { useState } from 'react';
import { REVIEW_SOURCES, type ReviewSource } from '@managedops/shared';
import { Badge, Button, Card, Field, Modal, Select, TextArea } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { formatDate, humanise } from '../onboarding/format';
import { useTrainer } from '../workforce/api';
import { QualitySummary } from './summary';
import { useCreateReview, useRetractReview, useTrainerReviews, type Review } from './api';

/**
 * What has been said about a trainer's delivery.
 *
 * A trainer opening their own gets the scores and the trend and not the words:
 * feedback nobody can see cannot improve anybody, but learner remarks are
 * written under an expectation of anonymity and handing them over verbatim
 * would change what people write. The API decides that, not this screen — it
 * simply renders what it was given.
 */
export function TrainerReviewsTab({
  trainerId,
  /** Addressed to the person themselves, on their own profile. */
  self = false,
}: {
  trainerId: string;
  self?: boolean;
}) {
  const reviews = useTrainerReviews(trainerId);
  const [adding, setAdding] = useState(false);
  const [retracting, setRetracting] = useState<Review | null>(null);

  return (
    <div className="space-y-5">
      {reviews.isPending ? (
        <LoadingState label="Loading feedback" rows={3} />
      ) : reviews.isError ? (
        <ErrorState error={reviews.error} onRetry={() => void reviews.refetch()} />
      ) : (
        <>
          <Card
            title={self ? 'How you are rated' : 'How they are rated'}
            description={
              self
                ? 'What clients, learners and observers have said about your delivery.'
                : 'The evidence behind whether we would work with them again.'
            }
          >
            <QualitySummary summary={reviews.data.summary} />
          </Card>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-soft">
              {reviews.data.viewer.readsComments
                ? 'Every review, including any that were withdrawn.'
                : 'Your scores. Individual comments stay with whoever wrote them.'}
            </p>
            {reviews.data.viewer.mayWrite ? (
              <Button onClick={() => setAdding(true)}>Record feedback</Button>
            ) : null}
          </div>

          {reviews.data.data.length === 0 ? (
            <EmptyState
              title="Nothing recorded yet"
              description="Feedback here is what a re-hire decision rests on later."
            />
          ) : (
            <ul className="space-y-3">
              {reviews.data.data.map((review) => (
                <ReviewCard
                  key={review.id}
                  review={review}
                  mayRetract={reviews.data.viewer.mayRetract}
                  onRetract={() => setRetracting(review)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <RecordDialog open={adding} trainerId={trainerId} onClose={() => setAdding(false)} />
      <RetractDialog review={retracting} onClose={() => setRetracting(null)} />
    </div>
  );
}

function ReviewCard({
  review,
  mayRetract,
  onRetract,
}: {
  review: Review;
  mayRetract: boolean;
  onRetract: () => void;
}) {
  const withdrawn = review.retractedAt != null;

  return (
    <li
      className={`rounded-lg border p-4 ${
        withdrawn ? 'border-line bg-surface-sunk' : 'border-line bg-surface'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{humanise(review.source)}</Badge>
            <span className="text-lg font-semibold tabular-nums text-ink">{review.rating}</span>
            <span className="text-xs text-ink-soft">out of 5</span>
            {withdrawn ? <Badge tone="critical">Withdrawn</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            {review.assignment.project.name} · {formatDate(review.observedOn)}
            {review.respondents ? ` · ${review.respondents} respondents` : ''}
            {review.submittedBy ? ` · recorded by ${review.submittedBy.name}` : ''}
          </p>
        </div>
        {mayRetract && !withdrawn ? (
          <Button variant="secondary" onClick={onRetract}>
            Withdraw
          </Button>
        ) : null}
      </div>

      {review.comment ? (
        <p className={`mt-3 text-sm ${withdrawn ? 'text-ink-faint line-through' : 'text-ink'}`}>
          {review.comment}
        </p>
      ) : null}

      {withdrawn ? (
        <p className="mt-2 text-xs text-ink-soft">
          Withdrawn{review.retractedBy ? ` by ${review.retractedBy.name}` : ''}:{' '}
          {review.retractedReason}
        </p>
      ) : null}
    </li>
  );
}

function RecordDialog({
  open,
  trainerId,
  onClose,
}: {
  open: boolean;
  trainerId: string;
  onClose: () => void;
}) {
  const trainer = useTrainer(open ? trainerId : null);
  const create = useCreateReview();

  const [assignmentId, setAssignmentId] = useState('');
  const [source, setSource] = useState<ReviewSource>('internal_observation');
  const [rating, setRating] = useState('4');
  const [knowledge, setKnowledge] = useState('');
  const [delivery, setDelivery] = useState('');
  const [professionalism, setProfessionalism] = useState('');
  const [respondents, setRespondents] = useState('');
  const [comment, setComment] = useState('');
  const [observedOn, setObservedOn] = useState(new Date().toISOString().slice(0, 10));
  const [problem, setProblem] = useState<string | null>(null);

  function close() {
    setProblem(null);
    onClose();
  }

  async function submit() {
    setProblem(null);
    try {
      await create.mutateAsync({
        assignmentId,
        source,
        rating: Number(rating),
        ...(knowledge ? { knowledge: Number(knowledge) } : {}),
        ...(delivery ? { delivery: Number(delivery) } : {}),
        ...(professionalism ? { professionalism: Number(professionalism) } : {}),
        ...(respondents ? { respondents: Number(respondents) } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        observedOn,
      });
      close();
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  const assignments = trainer.data?.assignments ?? [];

  return (
    <Modal
      open={open}
      title="Record feedback"
      description="Against the engagement it happened on. It cannot be edited afterwards — a mistake is withdrawn and a correction is a new review."
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
          label="Engagement"
          required
          value={assignmentId}
          onChange={(event) => setAssignmentId(event.target.value)}
        >
          <option value="">Choose the project</option>
          {assignments.map((assignment) => (
            <option key={assignment.id} value={assignment.id}>
              {assignment.project.name}
            </option>
          ))}
        </Select>

        <div className="grid gap-5 sm:grid-cols-2">
          <Select
            label="Where it came from"
            value={source}
            onChange={(event) => setSource(event.target.value as ReviewSource)}
          >
            {REVIEW_SOURCES.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </Select>
          <Field
            label="When the work happened"
            type="date"
            value={observedOn}
            onChange={(event) => setObservedOn(event.target.value)}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Rating label="Overall" required value={rating} onChange={setRating} />
          {source === 'learner_batch' ? (
            <Field
              label="How many learners"
              type="number"
              min={1}
              required
              hint="A batch summary without a headcount cannot be weighed against anything."
              value={respondents}
              onChange={(event) => setRespondents(event.target.value)}
            />
          ) : null}
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          <Rating label="Knowledge" value={knowledge} onChange={setKnowledge} />
          <Rating label="Delivery" value={delivery} onChange={setDelivery} />
          <Rating label="Professionalism" value={professionalism} onChange={setProfessionalism} />
        </div>

        <TextArea
          label="Comment"
          rows={3}
          hint="What a score alone does not say."
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={create.isPending}
            disabled={!assignmentId || (source === 'learner_batch' && !respondents)}
          >
            Record it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Rating({
  label,
  value,
  required,
  onChange,
}: {
  label: string;
  value: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      label={label}
      required={required}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {required ? null : <option value="">No view</option>}
      {[1, 2, 3, 4, 5].map((score) => (
        <option key={score} value={score}>
          {score}
        </option>
      ))}
    </Select>
  );
}

function RetractDialog({ review, onClose }: { review: Review | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const retract = useRetractReview();

  async function submit() {
    setProblem(null);
    try {
      await retract.mutateAsync({ id: review!.id, reason: reason.trim() });
      setReason('');
      onClose();
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={review !== null}
      title="Withdraw this review"
      description="It stays on the record as withdrawn, with your reason. It stops counting towards the score."
      onClose={() => {
        setReason('');
        setProblem(null);
        onClose();
      }}
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
          label="Why"
          required
          rows={3}
          hint="At least a sentence. Somebody reading this later needs to understand the decision."
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={retract.isPending}
            disabled={reason.trim().length < 10}
          >
            Withdraw it
          </Button>
        </div>
      </div>
    </Modal>
  );
}
