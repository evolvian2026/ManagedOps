import { useState } from 'react';
import type { BillingState } from '@managedops/shared';
import { Badge, Button, Field, Modal, Table, TextArea, Td, Th } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { formatInr } from '../onboarding/format';
import { useAuth } from '../auth/auth-context';
import {
  useMarginAssignments,
  useSetBillRate,
  type GroupBy,
  type MarginAssignment,
  type MarginFilters,
} from './api';

/**
 * What a margin row is actually made of, and the one thing you can do about it.
 *
 * The report diagnoses and, until now, stopped there: a project reading thin
 * told you nothing about which assignment made it thin, and the rate that would
 * fix it lives two screens away. A margin row is a roll-up; a rate is agreed
 * per person per client. This is the join between them.
 */
export function MarginAssignmentsDialog({
  open,
  onClose,
  filters,
  row,
  undecidedOnly = false,
}: {
  open: boolean;
  onClose: () => void;
  filters: MarginFilters;
  row: { key: string; label: string } | null;
  undecidedOnly?: boolean;
}) {
  const query = useMarginAssignments(
    { ...filters, key: row?.key, undecidedOnly },
    // Nothing is fetched until it is actually looked at: this hangs off every
    // row of a report that can be long.
    open,
  );

  const title = undecidedOnly ? 'Assignments awaiting a rate' : (row?.label ?? 'Assignments');

  return (
    <Modal
      open={open}
      wide
      title={title}
      description={
        undecidedOnly
          ? 'Neither a rate nor a decision. Each one understates the margin above.'
          : 'Every assignment behind this row, and what each one earned.'
      }
      onClose={onClose}
    >
      {query.isPending ? (
        <LoadingState label="Finding the assignments" rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.rows.length === 0 ? (
        <EmptyState
          title={undecidedOnly ? 'Every assignment is accounted for' : 'Nothing delivered here'}
          description={
            undecidedOnly
              ? 'Each one either has a rate or a stated reason it is not billed.'
              : 'No attendance was recorded against these assignments in this period.'
          }
        />
      ) : (
        <div>
          <Table
            compact
            caption="Assignments"
            head={
              <>
                <Th>Trainer</Th>
                <Th>Billing</Th>
                <Th className="text-right">Days</Th>
                <Th className="text-right">Revenue</Th>
                <Th className="text-right">Margin</Th>
              </>
            }
          >
            {query.data.rows.map((assignment) => (
              <AssignmentRow
                key={assignment.assignmentId}
                assignment={assignment}
                // Whatever the dialog is already titled by is not worth
                // repeating on every row: a project drill-down that restates
                // the project four times pushes the margin off the edge.
                context={row ? filters.groupBy : 'none'}
              />
            ))}
          </Table>
        </div>
      )}
    </Modal>
  );
}

function AssignmentRow({
  assignment,
  context,
}: {
  assignment: MarginAssignment;
  context: GroupBy | 'none';
}) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);

  // What the row still has to say, given what the title already said.
  const sublabel =
    context === 'project'
      ? assignment.clientName
      : context === 'client'
        ? assignment.projectName
        : `${assignment.projectName} · ${assignment.clientName}`;

  return (
    <>
      <tr>
        <Td>
          <div className="font-medium text-ink">{assignment.trainerName}</div>
          <div className="text-xs text-ink-soft">{sublabel}</div>
        </Td>
        <Td>
          {can('billing.manage') ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-sm text-left underline decoration-dotted underline-offset-4 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <BillingLabel assignment={assignment} />
            </button>
          ) : (
            <BillingLabel assignment={assignment} />
          )}
        </Td>
        <Td className="text-right tabular-nums text-ink-soft">{assignment.billableDays}</Td>
        <Td className="text-right tabular-nums">
          {assignment.billRatePerDay === null ? (
            <span className="text-xs text-ink-faint">—</span>
          ) : (
            formatInr(assignment.revenue)
          )}
        </Td>
        <Td className="text-right tabular-nums">
          <span className={assignment.margin < 0 ? 'font-medium text-danger' : 'font-medium'}>
            {formatInr(assignment.margin)}
          </span>
        </Td>
      </tr>
      <BillingDialog open={editing} assignment={assignment} onClose={() => setEditing(false)} />
    </>
  );
}

/** The three states, each said in words rather than left as a blank cell. */
function BillingLabel({ assignment }: { assignment: MarginAssignment }) {
  if (assignment.billing === 'rated') {
    return <span className="tabular-nums">{formatInr(assignment.billRatePerDay ?? 0)} / day</span>;
  }
  if (assignment.billing === 'not_billed') {
    return (
      <span>
        <Badge tone="neutral">Not billed</Badge>
        <span className="mt-0.5 block text-xs text-ink-soft">{assignment.notBilledReason}</span>
      </span>
    );
  }
  return <Badge tone="pending">No rate yet</Badge>;
}

/**
 * How this assignment is billed: a rate, or a stated decision not to bill it.
 *
 * Deliberately one dialog with two answers rather than a rate field and a
 * separate tick box. They are mutually exclusive — the database refuses a row
 * holding both — and presenting them as one question is what stops somebody
 * setting a rate and leaving a stale "internal work" note underneath it.
 */
function BillingDialog({
  open,
  assignment,
  onClose,
}: {
  open: boolean;
  assignment: MarginAssignment;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<Exclude<BillingState, 'undecided'>>(
    assignment.billing === 'not_billed' ? 'not_billed' : 'rated',
  );
  const [rate, setRate] = useState(assignment.billRatePerDay?.toString() ?? '');
  const [reason, setReason] = useState(assignment.notBilledReason ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSetBillRate();

  async function submit() {
    setProblem(null);
    try {
      await save.mutateAsync({
        assignmentId: assignment.assignmentId,
        billRatePerDay: choice === 'rated' ? Number(rate) : null,
        notBilledReason: choice === 'not_billed' ? reason : null,
      });
      onClose();
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  const invalid =
    choice === 'rated'
      ? rate.trim() === '' || Number.isNaN(Number(rate))
      : reason.trim().length < 4;

  return (
    <Modal
      open={open}
      title="How is this billed?"
      description={`${assignment.trainerName} on ${assignment.projectName}.`}
      onClose={onClose}
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

        <fieldset className="space-y-4">
          <legend className="sr-only">How this work is billed</legend>

          {/* The conditional field is a sibling of the radio's label, never
              inside it: a label wrapping another field absorbs that field's
              own label into the radio's accessible name, so a screen reader
              announces the choice as "At a day rateRate per day". */}
          <div>
            <label className="flex cursor-pointer gap-2">
              <input
                type="radio"
                name="billing"
                value="rated"
                checked={choice === 'rated'}
                onChange={() => setChoice('rated')}
                className="mt-1"
              />
              <span className="text-sm font-medium text-ink">At a day rate</span>
            </label>
            {choice === 'rated' ? (
              // Spacing on a wrapper: Field passes className to the input, and
              // TextArea overwrites it outright.
              <div className="mt-2 pl-6">
                <Field
                  label="Rate per day"
                  type="number"
                  min={0}
                  value={rate}
                  hint="In rupees, for each day this trainer delivers."
                  onChange={(event) => setRate(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          <div>
            <label className="flex cursor-pointer gap-2">
              <input
                type="radio"
                name="billing"
                value="not_billed"
                checked={choice === 'not_billed'}
                onChange={() => setChoice('not_billed')}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-ink">Not billed at all</span>
                <span className="block text-sm text-ink-soft">
                  Internal delivery, goodwill, or work absorbed into a fixed fee.
                </span>
              </span>
            </label>
            {choice === 'not_billed' ? (
              <div className="mt-2 pl-6">
                <TextArea
                  label="Why"
                  rows={2}
                  value={reason}
                  hint="Recorded against your name. “Not billed” with no reason reads a month later as nobody having got round to it."
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
            ) : null}
          </div>
        </fieldset>

        <p className="text-xs text-ink-soft">
          This affects the margin from now on and for the whole of the period you are looking at. It
          does not change any invoice already raised.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={save.isPending} disabled={invalid}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
