import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ActionItem, DashboardTile } from '@managedops/shared';
import { api } from '../../lib/api';
import { useAuth } from '../auth/auth-context';
import { Badge, Card, PageHeader } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/states';
import { formatIst, humanise } from '../onboarding/format';
import { useDashboard } from '../exit/api';

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

const TILE_ACCENT: Record<DashboardTile['tone'], string> = {
  neutral: 'text-ink',
  positive: 'text-primary',
  pending: 'text-accent',
  critical: 'text-danger',
};

/**
 * The landing screen: what is true, what is waiting, and what just happened.
 *
 * Every number is counted server-side through the same scope the list behind it
 * uses, so a tile can never promise rows the screen would then refuse to show.
 * The tiles a person gets are decided by the capabilities they hold, which is
 * why a trainer's dashboard is about their own day and an approver's is about
 * their queue — rather than one layout with half of it permanently reading zero.
 */
export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const dashboard = useDashboard();
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

      {dashboard.isPending ? (
        <LoadingState label="Loading your dashboard" rows={2} />
      ) : dashboard.isError ? (
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      ) : (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {dashboard.data.tiles.map((tile) => (
            <button
              key={tile.key}
              type="button"
              onClick={() => navigate(tile.href)}
              className="rounded-lg border border-line bg-surface p-5 text-left transition-colors hover:border-primary/40 hover:bg-primary-wash/30"
            >
              <p className={`text-3xl font-semibold tabular-nums ${TILE_ACCENT[tile.tone]}`}>
                {tile.value}
              </p>
              <p className="mt-1 text-sm text-ink-soft">{tile.label}</p>
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card
          title="Waiting on you"
          description="Oldest first — the thing that has been waiting longest is the thing to do."
        >
          {dashboard.isPending ? (
            <LoadingState label="Loading your queue" rows={3} />
          ) : dashboard.isError ? (
            <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
          ) : dashboard.data.actions.length === 0 ? (
            <EmptyState
              title="Nothing is waiting on you"
              description="Approvals, corrections and your own outstanding items appear here."
            />
          ) : (
            <ul className="space-y-2">
              {dashboard.data.actions.map((action) => (
                <ActionRow key={`${action.kind}-${action.id}`} action={action} />
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-5">
          <Card title="Recent notifications">
            {notifications.isPending ? (
              <LoadingState label="Loading notifications" rows={2} />
            ) : notifications.isError ? (
              <ErrorState
                error={notifications.error}
                onRetry={() => void notifications.refetch()}
              />
            ) : notifications.data.data.length === 0 ? (
              <EmptyState
                title="Nothing yet"
                description="Reminders and decisions about your work land here."
              />
            ) : (
              <ul className="space-y-3">
                {notifications.data.data.map((notification) => (
                  <li key={notification.id} className="text-sm">
                    <div className="flex items-start gap-2">
                      {notification.readAt ? null : (
                        <span
                          aria-label="Unread"
                          className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                        />
                      )}
                      <div className="min-w-0">
                        <p className="font-medium text-ink">{notification.title}</p>
                        <p className="text-xs text-ink-soft">{notification.body}</p>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {formatIst(notification.createdAt)}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Only somebody who may read the audit log gets the activity feed; for
              everybody else the API returns nothing and the card stays away. */}
          {dashboard.data && dashboard.data.recent.length > 0 ? (
            <Card title="Recent activity">
              <ul className="space-y-2 text-sm">
                {dashboard.data.recent.map((entry) => (
                  <li key={entry.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-ink">{entry.entityType}</p>
                      <p className="truncate text-xs text-ink-soft">{entry.action}</p>
                    </div>
                    <div className="shrink-0 text-right text-xs text-ink-faint">
                      <div>{entry.actor ?? 'system'}</div>
                      <div className="tabular-nums">{formatIst(entry.at, 'short')}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function ActionRow({ action }: { action: ActionItem }) {
  const navigate = useNavigate();

  return (
    <li>
      <button
        type="button"
        onClick={() => navigate(action.href)}
        className="flex w-full items-start justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary-wash/30"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{action.title}</p>
          <p className="text-xs text-ink-soft">{action.detail}</p>
        </div>
        <div className="shrink-0 text-right">
          <Badge tone="pending">{humanise(action.kind)}</Badge>
          <p className="mt-1 text-xs text-ink-faint tabular-nums">
            {formatIst(action.since, 'short')}
          </p>
        </div>
      </button>
    </li>
  );
}
