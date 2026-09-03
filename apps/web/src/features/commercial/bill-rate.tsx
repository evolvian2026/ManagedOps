import { useState } from 'react';
import { Button, Field, Modal } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { formatInr } from '../onboarding/format';
import { useAuth } from '../auth/auth-context';
import { useSetBillRate } from './api';

/**
 * The day rate on one assignment, shown and — for a manager — editable in place.
 *
 * Clearing the field is a real answer rather than a cancelled edit: internal
 * work exists, and recording it as "not billed" is what keeps it out of the
 * margin as an apparent loss.
 */
export function BillRateCell({
  assignmentId,
  rate,
}: {
  assignmentId: string;
  rate: string | null;
}) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);

  const label =
    rate == null ? <span className="text-xs text-ink-faint">Not billed</span> : formatInr(rate);

  if (!can('billing.manage')) return <span className="tabular-nums">{label}</span>;

  return (
    <>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded-sm tabular-nums underline decoration-dotted underline-offset-4 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {label}
      </button>
      <BillRateDialog
        open={editing}
        assignmentId={assignmentId}
        rate={rate}
        onClose={() => setEditing(false)}
      />
    </>
  );
}

function BillRateDialog({
  open,
  assignmentId,
  rate,
  onClose,
}: {
  open: boolean;
  assignmentId: string;
  rate: string | null;
  onClose: () => void;
}) {
  const [value, setValue] = useState(rate ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSetBillRate();

  async function submit() {
    setProblem(null);
    try {
      await save.mutateAsync({
        assignmentId,
        // An empty field means "not billed", which the API stores as null.
        billRatePerDay: value.trim() === '' ? null : Number(value),
      });
      onClose();
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }

  return (
    <Modal
      open={open}
      title="Day rate"
      description="What this client pays per day that this trainer delivers."
      onClose={() => {
        setValue(rate ?? '');
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

        <Field
          label="Rate per day"
          type="number"
          min={0}
          value={value}
          hint="In rupees. Leave it empty for work that is not billed to the client."
          onChange={(event) => setValue(event.target.value)}
        />

        <p className="text-xs text-ink-soft">
          Changing this affects the margin from now on and for the whole of the period you are
          looking at. It does not change any invoice already raised.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} pending={save.isPending}>
            Save rate
          </Button>
        </div>
      </div>
    </Modal>
  );
}
