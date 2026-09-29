import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Field } from '../../components/ui';
import { ErrorState, LoadingState } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../auth/auth-context';

interface MessageEvent {
  notificationType: string;
  templates: string[];
  /** What it is for. Two templates can share one event, so this is a list. */
  purposes: string[];
  /** False for the message sent before anybody could have chosen about it. */
  canDecline: boolean;
  declined: boolean;
  declinedAt: string | null;
}

interface ContactPreferences {
  phone: string | null;
  phoneMasked: string | null;
  mobileNotifications: boolean;
  /** One entry per event, with what it is for and whether it is turned off. */
  events: MessageEvent[];
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
    mutationFn: (body: {
      phone?: string;
      mobileNotifications?: boolean;
      declinedNotificationTypes?: string[];
    }) => api.patch<ContactPreferences>('/notifications/preferences', body),
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
  const { user } = useAuth();
  const preferences = useContactPreferences();
  const update = useUpdateContactPreferences();
  const [phone, setPhone] = useState<string | null>(null);

  if (preferences.isPending) return <LoadingState label="Loading how we reach you" rows={2} />;
  if (preferences.isError) {
    return <ErrorState error={preferences.error} onRetry={() => void preferences.refetch()} />;
  }

  const current = preferences.data;
  // Every message in the catalogue is addressed to a trainer about their own
  // work. Listing them to an administrator promised messages that would never
  // arrive, which is worse than saying nothing.
  const receivesMessages = Boolean(user?.trainerId);
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

          {receivesMessages ? (
            <MessageEvents
              events={current.events}
              enabled={on}
              pending={update.isPending}
              onChange={(declined) => update.mutate({ declinedNotificationTypes: declined })}
            />
          ) : (
            <p className="mt-4 text-sm text-ink-soft">
              These messages go to trainers about their own work, so nothing is currently sent to
              your phone. Your number is here so colleagues can reach you.
            </p>
          )}
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

/**
 * One switch per kind of message.
 *
 * Switches rather than the flat list this used to be, because the master switch
 * was the only control and it is too blunt: somebody who does not want a text
 * about every expense claim had to turn the whole channel off, taking the
 * document reminders with it — and those are the ones that cost them site
 * access when missed.
 *
 * Rendered from what the server sends, which comes from the same catalogue the
 * sender reads. An event added later becomes a switch here with nobody
 * remembering to come back.
 */
function MessageEvents({
  events,
  enabled,
  pending,
  onChange,
}: {
  events: MessageEvent[];
  enabled: boolean;
  pending: boolean;
  onChange: (declined: string[]) => void;
}) {
  function toggle(type: string, wanted: boolean) {
    // The whole set, every time: the server replaces what it holds with this,
    // so two quick taps cannot leave it disagreeing with what is on screen.
    const declined = events
      .filter((event) =>
        event.notificationType === type ? !wanted : event.canDecline && event.declined,
      )
      .map((event) => event.notificationType);
    onChange(declined);
  }

  return (
    <div className="mt-4">
      <p className="text-xs font-semibold tracking-wide text-ink-soft uppercase">
        What we would send
      </p>
      {/* Kept visible rather than hidden when the channel is off: hiding them
          would leave somebody turning the channel back on with no idea what
          they had chosen underneath it. */}
      {!enabled ? (
        <p className="mt-2 text-sm text-ink-soft">
          Messages to your phone are off, so none of these are sent. Your choices are kept for if
          you turn them back on.
        </p>
      ) : null}

      <ul className="mt-2 divide-y divide-line border-t border-line">
        {events.map((event) => (
          <li
            key={event.notificationType}
            className="flex flex-wrap items-start justify-between gap-3 py-2.5"
          >
            <div className="min-w-[14rem] flex-1">
              {event.purposes.map((purpose) => (
                <p key={purpose} className="text-sm text-ink">
                  {purpose}
                </p>
              ))}
              {!event.canDecline ? (
                <p className="mt-0.5 text-xs text-ink-soft">
                  Always sent — it goes out when your account is created, before you could have
                  chosen.
                </p>
              ) : null}
            </div>

            {event.canDecline ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!event.declined}
                  disabled={pending || !enabled}
                  aria-label={event.purposes[0]}
                  onChange={(input) => toggle(event.notificationType, input.target.checked)}
                />
                <span className={event.declined ? 'text-ink-faint' : 'text-ink-soft'}>
                  {event.declined ? 'Off' : 'On'}
                </span>
              </label>
            ) : (
              <span className="text-sm text-ink-faint">Always on</span>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-ink-soft">
        These govern your phone only. Everything still appears in the app and in your email.
      </p>
    </div>
  );
}
