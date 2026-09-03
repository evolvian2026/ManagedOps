import type { Capability } from '@managedops/shared';

/**
 * The sidebar, declared once. Each item names the capability it needs, so the
 * navigation a person sees is derived from the same permission matrix the API
 * enforces — a link never appears for a screen its owner would be refused.
 */
export interface NavItem {
  label: string;
  path: string;
  /** Absent means every signed-in user sees it. */
  capability?: Capability;
  section: 'work' | 'admin';
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Dashboard', path: '/', section: 'work' },

  // Recruitment and delivery — arriving in phases 1 to 4.
  { label: 'Onboarding', path: '/onboarding', capability: 'positions.read', section: 'work' },
  { label: 'Running Projects', path: '/projects', capability: 'projects.read', section: 'work' },
  { label: 'Approvals', path: '/approvals', capability: 'leave.approve', section: 'work' },
  { label: 'Deboarding', path: '/deboarding', capability: 'deboarding.read', section: 'work' },
  { label: 'Talent Pool', path: '/pool', capability: 'pool.read', section: 'work' },
  { label: 'Flags', path: '/flags', capability: 'flags.raise', section: 'work' },

  // The commercial side. Clients is the directory HR staffs against; Margin is
  // the money, which is a narrower audience.
  { label: 'Find Trainers', path: '/find-trainers', capability: 'matching.read', section: 'work' },
  { label: 'Clients', path: '/clients', capability: 'clients.read', section: 'work' },
  { label: 'Margin', path: '/margin', capability: 'billing.read', section: 'work' },
  { label: 'Payroll', path: '/payroll', capability: 'payroll.read', section: 'work' },

  // Trainer self-service.
  {
    label: 'My Profile',
    path: '/my/profile',
    capability: 'trainers.upload_documents',
    section: 'work',
  },
  // One screen rather than five: the punch, the month, the sessions taught, the
  // deliverables owed and the kit issued are all the same assignment.
  { label: 'My Work', path: '/my/work', capability: 'attendance.punch', section: 'work' },
  { label: 'My Leave', path: '/my/leave', capability: 'leave.request', section: 'work' },
  {
    label: 'My Reimbursements',
    path: '/my/reimbursements',
    capability: 'reimbursements.submit',
    section: 'work',
  },

  { label: 'Audit Log', path: '/audit', capability: 'audit.read', section: 'admin' },
  { label: 'Users', path: '/users', capability: 'users.manage', section: 'admin' },
];

export function visibleNavItems(capabilities: readonly Capability[]): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.capability || capabilities.includes(item.capability));
}
