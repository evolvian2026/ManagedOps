import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../auth/auth-context';
import { Card, PageHeader } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

interface NotificationPage {
  data: NotificationRow[];
  meta: { total: number; unread: number };
}

/**
 * The landing screen. Phase 0 shows who you are signed in as and what is waiting
 * for you; the KPI tiles and action queue arrive with the modules that produce
 * them, rather than as placeholders that show numbers nothing computes.
 */
export function DashboardPage() {
  const { user } = useAuth();
  const notifications = useQuery({
    queryKey: ['notifications', { pageSize: 5 }],
    queryFn: ({ signal }) => api.get<NotificationPage>('/notifications?pageSize=5', signal),
  });

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user?.name.split(' ')[0] ?? 'there'}`}
        description="Everything waiting on you across ManagedOps."
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Waiting on you" description="Items assigned to you or your projects.">
          {notifications.isPending ? (
            <LoadingState label="Loading your notifications" rows={3} />
          ) : notifications.isError ? (
            <ErrorState error={notifications.error} onRetry={() => void notifications.refetch()} />
          ) : notifications.data.data.length === 0 ? (
            <EmptyState
              title="Nothing needs your attention"
              description="Approvals, reminders and flags raised on your projects will appear here."
            />
          ) : (
            <ul className="divide-y divide-line">
              {notifications.data.data.map((row) => (
                <li key={row.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${
                      row.readAt ? 'bg-line-strong' : 'bg-accent'
                    }`}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{row.title}</p>
                    <p className="text-sm text-ink-soft">{row.body}</p>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {new Date(row.createdAt).toLocaleString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                      {' IST'}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Your access" description="What your role lets you do.">
          <dl className="space-y-3.5 text-sm">
            {/* An email is long and unpredictable, so it gets its own line
                rather than fighting the label for width. */}
            <div>
              <dt className="text-xs text-ink-soft">Signed in as</dt>
              <dd className="mt-0.5 font-medium break-all text-ink">{user?.email}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-soft">Role</dt>
              <dd className="font-medium text-ink capitalize">{user?.role.replace(/_/g, ' ')}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-soft">Things you can do</dt>
              <dd className="font-medium text-ink tabular-nums">
                {user?.capabilities.length ?? 0}
              </dd>
            </div>
            {user && user.ledProjectIds.length > 0 ? (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-soft">Projects you lead</dt>
                <dd className="font-medium text-ink tabular-nums">{user.ledProjectIds.length}</dd>
              </div>
            ) : null}
          </dl>
        </Card>
      </div>
    </>
  );
}
