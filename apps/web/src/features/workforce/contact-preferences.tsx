import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Field } from '../../components/ui';
import { ErrorState, LoadingState } from '../../components/states';
import { api, errorMessage } from '../../lib/api';

interface ContactPreferences {
  phone: string | null;
  phoneMasked: string | null;
  mobileNotifications: boolean;
  /** What would be sent there, straight from the message catalogue. */
  purposes: string[];
}

function useContactPreferences() {
  return useQuery({
    queryKey: ['contact-preferences'],
    queryFn: ({ signal }) => api.get<ContactPreferences>('/notifications/preferences', signal),
  });
}

function useUpdateContactPreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { phone?: string; mobileNotifications?: boolean }) =>
      api.patch<ContactPreferences>('/notifications/preferences', body),
    onSuccess: (updated) => {
      client.setQueryData(['contact-preferences'], updated);
    },
  });
}

/**
 * Where phone messages go, and the switch that stops them.
 *
 * The list of what would be sent is not written here — it comes from the same
 * catalogue the sender reads, so a template added later shows up on this screen
 * without anybody remembering to come back and add a line.
 */
export function ContactPreferences() {
  const preferences = useContactPreferences();
  const update = useUpdateContactPreferences();
  const [phone, setPhone] = useState<string | null>(null);

  if (preferences.isPending) return <LoadingState label="Loading how we reach you" rows={2} />;
  if (preferences.isError) {
    return <ErrorState error={preferences.error} onRetry={() => void preferences.refetch()} />;
  }

  const current = preferences.data;
  // Null until they type: the stored number is shown masked, and starting the
  // field with the mask would have them save the dots back.
  const editing = phone !== null;
  const on = current.mobileNotifications;

  return (
    <Card
      title="How we reach you"
      description="WhatsApp where we can, a text message where we cannot."
    >
      <div className="space-y-5">
        <div>
          <p className="text-sm font-medium text-ink">Mobile number</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            {current.phoneMasked ?? 'None on file — nothing can be sent to your phone.'}
          </p>

          {editing ? (
            <form
              className="mt-3 flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                update.mutate({ phone: phone.trim() }, { onSuccess: () => setPhone(null) });
              }}
            >
              <div className="min-w-[14rem] flex-1">
                <Field
                  label="New number"
                  name="phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="98000 01002"
                  hint="An Indian mobile number. Leave it empty to remove the one on file."
                  autoFocus
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" pending={update.isPending}>
                  Save
                </Button>
                <Button type="button" variant="secondary" onClick={() => setPhone(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button
              variant="secondary"
              className="mt-3"
              onClick={() => setPhone(current.phone ?? '')}
            >
              {current.phone ? 'Change number' : 'Add a number'}
            </Button>
          )}
        </div>

        <div className="border-t border-line pt-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-ink">Messages to your phone</p>
              <p className="mt-0.5 text-sm text-ink-soft">
                {on
                  ? 'On. These still appear in the app and in your email either way.'
                  : 'Off. You will still get everything in the app and by email.'}
              </p>
            </div>
            <Button
              variant="secondary"
              pending={update.isPending}
              onClick={() => update.mutate({ mobileNotifications: !on })}
            >
              {on ? 'Turn off' : 'Turn on'}
            </Button>
          </div>

          <p className="mt-4 text-xs font-semibold tracking-wide text-ink-soft uppercase">
            What we would send
          </p>
          <ul className="mt-2 space-y-1 text-sm text-ink-soft">
            {current.purposes.map((purpose) => (
              <li key={purpose}>· {purpose}</li>
            ))}
          </ul>
        </div>

        {update.isError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {errorMessage(update.error)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
