import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Capability } from '@managedops/shared';
import { useAuth } from '../features/auth/auth-context';
import { LoginPage } from '../features/auth/login-page';
import { ChangePasswordPage } from '../features/auth/change-password-page';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { OnboardingPage } from '../features/onboarding/onboarding-page';
import { RunningProjectsPage } from '../features/workforce/running-projects';
import { MyProfilePage } from '../features/workforce/my-profile';
import { MyWorkPage } from '../features/operations/my-work';
import { MyLeavePage } from '../features/operations/my-leave';
import { MyReimbursementsPage } from '../features/operations/my-reimbursements';
import { ApprovalsPage } from '../features/operations/approvals';
import { FlagsPage } from '../features/operations/flags';
import { DeboardingPage } from '../features/exit/deboarding';
import { TalentPoolPage } from '../features/exit/talent-pool';
import { FindTrainersPage } from '../features/skills/find-trainers';
import { ClientsPage } from '../features/commercial/clients';
import { MarginPage } from '../features/commercial/margin';
import { AuditLogPage } from '../features/admin/audit-log';
import { UsersPage } from '../features/admin/users';
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
              <OnboardingPage />
            </RequireCapability>
          }
        />
        <Route
          path="projects"
          element={
            <RequireCapability capability="projects.read">
              <RunningProjectsPage />
            </RequireCapability>
          }
        />
        <Route
          path="find-trainers"
          element={
            <RequireCapability capability="matching.read">
              <FindTrainersPage />
            </RequireCapability>
          }
        />
        <Route
          path="clients"
          element={
            <RequireCapability capability="clients.read">
              <ClientsPage />
            </RequireCapability>
          }
        />
        <Route
          path="margin"
          element={
            <RequireCapability capability="billing.read">
              <MarginPage />
            </RequireCapability>
          }
        />
        <Route
          path="deboarding"
          element={
            <RequireCapability capability="deboarding.read">
              <DeboardingPage />
            </RequireCapability>
          }
        />
        <Route
          path="pool"
          element={
            <RequireCapability capability="pool.read">
              <TalentPoolPage />
            </RequireCapability>
          }
        />
        <Route
          path="approvals"
          element={
            <RequireCapability capability="leave.approve">
              <ApprovalsPage />
            </RequireCapability>
          }
        />
        <Route
          path="flags"
          element={
            <RequireCapability capability="flags.raise">
              <FlagsPage />
            </RequireCapability>
          }
        />
        <Route
          path="my/profile"
          element={
            <RequireCapability capability="trainers.upload_documents">
              <MyProfilePage />
            </RequireCapability>
          }
        />
        <Route
          path="my/work"
          element={
            <RequireCapability capability="attendance.punch">
              <MyWorkPage />
            </RequireCapability>
          }
        />
        {/* The sidebar entry became "My Work"; anyone with the old link still lands. */}
        <Route path="my/attendance" element={<Navigate to="/my/work" replace />} />
        <Route
          path="my/leave"
          element={
            <RequireCapability capability="leave.request">
              <MyLeavePage />
            </RequireCapability>
          }
        />
        <Route
          path="my/reimbursements"
          element={
            <RequireCapability capability="reimbursements.submit">
              <MyReimbursementsPage />
            </RequireCapability>
          }
        />
        <Route
          path="audit"
          element={
            <RequireCapability capability="audit.read">
              <AuditLogPage />
            </RequireCapability>
          }
        />
        <Route
          path="users"
          element={
            <RequireCapability capability="users.manage">
              <UsersPage />
            </RequireCapability>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
