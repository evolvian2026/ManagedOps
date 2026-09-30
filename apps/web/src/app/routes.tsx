import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Capability } from '@managedops/shared';
import { useAuth } from '../features/auth/auth-context';
import { LoginPage } from '../features/auth/login-page';
import { ChangePasswordPage } from '../features/auth/change-password-page';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { AppShell } from './app-shell';
import { LoadingState } from '../components/states';
import { PageHeader } from '../components/ui';

/**
 * Every screen behind the sign-in, fetched when it is first opened.
 *
 * One bundle used to carry the whole product to everybody. A contract trainer
 * on a phone between two client sites — the person this system was built for —
 * downloaded the payroll register, the margin report and the recruitment
 * pipeline in order to punch in.
 *
 * The split falls along the permission boundary for free: `RequireCapability`
 * returns before it renders its child, so a role without the capability never
 * triggers the import. A trainer's browser is not merely told it cannot open
 * the payroll register; it never fetches the code for it.
 *
 * Login, change-password and the dashboard stay in the entry chunk: everybody
 * needs the first two before anything else can happen, and everybody lands on
 * the third immediately after. Deferring those would buy nothing and add a
 * round trip to the two moments that are already the slowest.
 */
const OnboardingPage = lazy(() =>
  import('../features/onboarding/onboarding-page').then((module) => ({
    default: module.OnboardingPage,
  })),
);
const RunningProjectsPage = lazy(() =>
  import('../features/workforce/running-projects').then((module) => ({
    default: module.RunningProjectsPage,
  })),
);
const MyAccountPage = lazy(() =>
  import('../features/auth/my-account-page').then((module) => ({ default: module.MyAccountPage })),
);
const MyProfilePage = lazy(() =>
  import('../features/workforce/my-profile').then((module) => ({ default: module.MyProfilePage })),
);
const MyWorkPage = lazy(() =>
  import('../features/operations/my-work').then((module) => ({ default: module.MyWorkPage })),
);
const MyLeavePage = lazy(() =>
  import('../features/operations/my-leave').then((module) => ({ default: module.MyLeavePage })),
);
const MyReimbursementsPage = lazy(() =>
  import('../features/operations/my-reimbursements').then((module) => ({
    default: module.MyReimbursementsPage,
  })),
);
const ApprovalsPage = lazy(() =>
  import('../features/operations/approvals').then((module) => ({ default: module.ApprovalsPage })),
);
const FlagsPage = lazy(() =>
  import('../features/operations/flags').then((module) => ({ default: module.FlagsPage })),
);
const DeboardingPage = lazy(() =>
  import('../features/exit/deboarding').then((module) => ({ default: module.DeboardingPage })),
);
const TalentPoolPage = lazy(() =>
  import('../features/exit/talent-pool').then((module) => ({ default: module.TalentPoolPage })),
);
const FindTrainersPage = lazy(() =>
  import('../features/skills/find-trainers').then((module) => ({
    default: module.FindTrainersPage,
  })),
);
const ClientsPage = lazy(() =>
  import('../features/commercial/clients').then((module) => ({ default: module.ClientsPage })),
);
const MarginPage = lazy(() =>
  import('../features/commercial/margin').then((module) => ({ default: module.MarginPage })),
);
const PayrollRegisterPage = lazy(() =>
  import('../features/payroll/register').then((module) => ({
    default: module.PayrollRegisterPage,
  })),
);
const DocumentCompliancePage = lazy(() =>
  import('../features/compliance/documents').then((module) => ({
    default: module.DocumentCompliancePage,
  })),
);
const AuditLogPage = lazy(() =>
  import('../features/admin/audit-log').then((module) => ({ default: module.AuditLogPage })),
);
const UsersPage = lazy(() =>
  import('../features/admin/users').then((module) => ({ default: module.UsersPage })),
);

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
            {/* One boundary around the shell rather than one per route: the
                fallback then appears in the content area with the sidebar
                already drawn, instead of blanking the whole page. */}
            <Suspense
              fallback={
                <div className="px-4 py-10">
                  <LoadingState label="Opening" rows={3} />
                </div>
              }
            >
              <AppShell />
            </Suspense>
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
          path="documents"
          element={
            <RequireCapability capability="trainers.read">
              <DocumentCompliancePage />
            </RequireCapability>
          }
        />
        <Route
          path="payroll"
          element={
            <RequireCapability capability="payroll.read">
              <PayrollRegisterPage />
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
        {/* No capability: every signed-in user has an account to look after. */}
        <Route path="my/account" element={<MyAccountPage />} />
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
