import { useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { ApiError, errorMessage } from '../../lib/api';
import { formatIst } from '../onboarding/format';
import { downloadCsv } from '../exit/api';
import { useExportLayouts, type PayrollFilters, type PayrollHandoff } from './api';

/**
 * Handing the month to payroll.
 *
 * Two things this does that a download button does not. It asks which layout,
 * because sending our own figures as though they were authoritative is a
 * different act from sending the days payroll cannot work out for itself. And
 * it turns the server's refusal into a sentence with a way forward, rather than
 * a download that silently fails.
 */
export function ExportControl({
  filters,
  onExported,
}: {
  filters: PayrollFilters;
  onExported: () => void;
}) {
  const layouts = useExportLayouts();
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState('days');
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function send(force: boolean) {
    setPending(true);
    setRefusal(null);
    try {
      // Never the filtered view: the file is always the whole month, so what
      // the screen happens to be showing cannot change what payroll receives.
      const search = new URLSearchParams({ month: filters.month, layout });
      if (force) search.set('force', 'true');
      await downloadCsv(
        `/payroll/register/export.csv?${search.toString()}`,
        `managedops-payroll-${filters.month}-${layout}.csv`,
      );
      setOpen(false);
      onExported();
    } catch (error) {
      // A refused month is the expected path, not a fault: it is shown here
      // with the option that resolves it.
      if (error instanceof ApiError && error.problem.status === 409) {
        setRefusal(error.problem.detail);
      } else {
        setRefusal(errorMessage(error));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Send to payroll
      </Button>

      <Modal
        open={open}
        title="Send to payroll"
        description={`The whole of ${filters.month}, whatever this screen is filtered to.`}
        onClose={() => {
          setOpen(false);
          setRefusal(null);
        }}
      >
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">What to send</legend>
            {(layouts.data ?? []).map((option) => (
              <label
                key={option.id}
                className="flex cursor-pointer gap-2 rounded-md border border-line p-3"
              >
                <input
                  type="radio"
                  name="layout"
                  value={option.id}
                  checked={layout === option.id}
                  onChange={() => setLayout(option.id)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-ink">{option.label}</span>
                  <span className="block text-sm text-ink-soft">{option.description}</span>
                  <span className="mt-1 block font-mono text-xs text-ink-faint">
                    {option.columns.join(', ')}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {refusal ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-sm text-ink"
            >
              {refusal}
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {refusal ? (
              // Only offered once the refusal has been read. Exporting a month
              // that is not settled is a decision, and it is recorded as one.
              <Button variant="secondary" pending={pending} onClick={() => void send(true)}>
                Send anyway, with the blockers
              </Button>
            ) : (
              <Button pending={pending} onClick={() => void send(false)}>
                Send
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}

/**
 * What payroll is holding, and whether it is still true.
 *
 * The register is worked out live, so a file sent on the 3rd can stop matching
 * by the 5th. Saying nothing would leave that to be discovered at the next
 * payday.
 */
export function LastHandoff({ handoff }: { handoff: PayrollHandoff | null }) {
  if (!handoff) {
    return <p className="text-sm text-ink-soft">This month has not been sent to payroll yet.</p>;
  }

  return (
    <div className="text-sm">
      <p className="text-ink">
        Sent to payroll {formatIst(handoff.at, 'short')} by {handoff.by} — {handoff.rowCount}{' '}
        {handoff.rowCount === 1 ? 'person' : 'people'}, {handoff.layout} layout
        {handoff.forced ? ', with unresolved rows' : ''}.
      </p>
      {handoff.stillCurrent ? (
        <p className="mt-0.5 text-ink-soft">The figures still match what was sent.</p>
      ) : (
        <p className="mt-0.5 font-medium text-danger">
          The figures have changed since. Send it again, or payroll pays from the old ones.
        </p>
      )}
    </div>
  );
}
