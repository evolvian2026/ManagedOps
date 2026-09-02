import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../features/auth/auth-context';
import { ErrorBoundary } from '../components/states';
import { Button } from '../components/ui';
import { visibleNavItems } from './navigation';

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  hr: 'HR',
  interviewer: 'Interviewer',
  project_lead: 'Project Lead',
  trainer: 'Trainer',
};

export function AppShell() {
  const { user, signOut } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  if (!user) return null;

  const items = visibleNavItems(user.capabilities);
  const work = items.filter((item) => item.section === 'work');
  const admin = items.filter((item) => item.section === 'admin');

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      <aside
        className={`border-line bg-surface lg:sticky lg:top-0 lg:h-screen lg:border-r ${
          drawerOpen ? 'block border-b' : 'hidden lg:block'
        }`}
      >
        <div className="flex items-center gap-2 px-5 py-4">
          <span className="text-base font-semibold tracking-tight text-ink">
            Managed<span className="text-primary">Ops</span>
          </span>
        </div>

        <nav aria-label="Main" className="px-3 pb-6">
          <NavGroup items={work} onNavigate={() => setDrawerOpen(false)} />
          {admin.length > 0 ? (
            <>
              <p className="mt-5 mb-1 px-2 text-[11px] font-semibold tracking-wider text-ink-faint uppercase">
                Administration
              </p>
              <NavGroup items={admin} onNavigate={() => setDrawerOpen(false)} />
            </>
          ) : null}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line bg-surface px-5 py-3">
          <Button
            variant="ghost"
            className="lg:hidden"
            aria-expanded={drawerOpen}
            aria-controls="main-navigation"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            Menu
          </Button>

          <div className="ml-auto flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm font-medium text-ink">{user.name}</p>
              <p className="text-xs text-ink-soft">{ROLE_LABELS[user.role] ?? user.role}</p>
            </div>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </header>

        {/* Per-route boundary: one screen failing must not blank the app. */}
        <main id="main" className="min-w-0 flex-1 px-5 py-6 lg:px-8">
          <ErrorBoundary area="This screen">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

function NavGroup({
  items,
  onNavigate,
}: {
  items: { label: string; path: string }[];
  onNavigate: () => void;
}) {
  return (
    <ul id="main-navigation" className="space-y-0.5">
      {items.map((item) => (
        <li key={item.path}>
          <NavLink
            to={item.path}
            end={item.path === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              `block rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-primary-wash font-medium text-primary'
                  : 'text-ink-soft hover:bg-surface-sunk hover:text-ink'
              }`
            }
          >
            {item.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}
