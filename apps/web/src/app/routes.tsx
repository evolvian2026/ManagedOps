import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Capability } from '@managedops/shared';
import { useAuth } from '../features/auth/auth-context';
import { LoginPage } from '../features/auth/login-page';
import { ChangePasswordPage } from '../features/auth/change-password-page';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { PlaceholderPage } from '../features/placeholder-page';
import { AppShell } from './app-shell';
import { LoadingState } from '../components/states';
import { PageHeader } from '../components/ui';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, initialising } = useAuth();
  const location = useLocation();

  // Until the refresh-cookie check finishes we do not know whether this person
  // is signed in; redirecting now would bounce a valid session to the login page
  // on every reload.
  if (initialising) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <LoadingState label="Restoring your session" rows={2} />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/** Hides a screen the signed-in role has no capability for. */
function RequireCapability({
  capability,
  children,
}: {
  capability: Capability;
  children: React.ReactNode;
}) {
  const { can } = useAuth();
  if (!can(capability)) {
    return (
      <>
        <PageHeader
          title="Not available to your role"
          description="Your role does not include this area. If you think it should, ask a super admin."
        />
      </>
    );
  }
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route
          path="onboarding"
          element={
            <RequireCapability capability="positions.read">
              <PlaceholderPage
                title="Onboarding"
                phase="phase 1"
                summary="Open positions, the interview pipeline and offer letters."
              />
            </RequireCapability>
          }
        />
        <Route
          path="projects"
          element={
            <RequireCapability capability="projects.read">
              <PlaceholderPage
                title="Running Projects"
                phase="phase 2"
                summary="Projects, their trainer rosters and today's attendance."
              />
            </RequireCapability>
          }
        />
        <Route
          path="deboarding"
          element={
            <RequireCapability capability="deboarding.read">
              <PlaceholderPage
                title="Deboarding"
                phase="phase 4"
                summary="Asset return, full and final settlement, and exit feedback."
              />
            </RequireCapability>
          }
        />
        <Route
          path="pool"
          element={
            <RequireCapability capability="pool.read">
              <PlaceholderPage
                title="Talent Pool"
                phase="phase 4"
                summary="Everyone we have screened or worked with before, ready to re-engage."
              />
            </RequireCapability>
          }
        />
        <Route
          path="flags"
          element={
            <RequireCapability capability="flags.raise">
              <PlaceholderPage
                title="Flags"
                phase="phase 3"
                summary="Concerns raised against a trainer, and the action taken."
              />
            </RequireCapability>
          }
        />
        <Route
          path="my/attendance"
          element={
            <RequireCapability capability="attendance.punch">
              <PlaceholderPage
                title="My Attendance"
                phase="phase 3"
                summary="Punch in and out, and review your attendance history."
              />
            </RequireCapability>
          }
        />
        <Route
          path="my/leave"
          element={
            <RequireCapability capability="leave.request">
              <PlaceholderPage
                title="My Leave"
                phase="phase 3"
                summary="Your balance, your requests and where each one stands."
              />
            </RequireCapability>
          }
        />
        <Route
          path="my/reimbursements"
          element={
            <RequireCapability capability="reimbursements.submit">
              <PlaceholderPage
                title="My Reimbursements"
                phase="phase 3"
                summary="Submit a claim with its proof, and track what has been paid."
              />
            </RequireCapability>
          }
        />
        <Route
          path="audit"
          element={
            <RequireCapability capability="audit.read">
              <PlaceholderPage
                title="Audit Log"
                phase="phase 5"
                summary="Every change, who made it and what it looked like before."
              />
            </RequireCapability>
          }
        />
        <Route
          path="users"
          element={
            <RequireCapability capability="users.manage">
              <PlaceholderPage
                title="Users"
                phase="phase 5"
                summary="Administrative accounts, roles and password resets."
              />
            </RequireCapability>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
