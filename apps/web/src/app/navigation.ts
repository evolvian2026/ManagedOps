import type { Capability } from '@managedops/shared';

/**
 * The sidebar, declared once.
 *
 * Each item names the capability it needs, so the navigation a person sees is
 * derived from the same permission matrix the API enforces — a link never
 * appears for a screen its owner would be refused.
 *
 * Items are grouped because a flat list stopped working at about eight. The
 * groups follow what somebody is actually doing rather than which module the
 * code lives in: a manager thinks "who is delivering, and did we make money",
 * not "workforce" and "commercial".
 */
export interface NavItem {
  label: string;
  path: string;
  /** Absent means every signed-in user sees it. */
  capability?: Capability;
  section: NavSection;
}

export type NavSection = 'home' | 'delivery' | 'people' | 'commercial' | 'yours' | 'admin';

/**
 * The order they appear in, and what each is called.
 *
 * `home` has no heading: one item does not need a label above it, and a
 * "Home / Dashboard" pair reads as a mistake.
 */
export const NAV_SECTIONS: { id: NavSection; label: string | null }[] = [
  { id: 'home', label: null },
  { id: 'delivery', label: 'Delivery' },
  { id: 'people', label: 'People' },
  { id: 'commercial', label: 'Commercial' },
  { id: 'yours', label: 'Your work' },
  { id: 'admin', label: 'Administration' },
];

export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Dashboard', path: '/', section: 'home' },

  // What is happening now, and the decisions waiting on it.
  {
    label: 'Running Projects',
    path: '/projects',
    capability: 'projects.read',
    section: 'delivery',
  },
  { label: 'Approvals', path: '/approvals', capability: 'leave.approve', section: 'delivery' },
  { label: 'Flags', path: '/flags', capability: 'flags.raise', section: 'delivery' },

  // A person's whole arc, in the order it happens: arrive, get matched to work,
  // stay compliant, leave, and come back.
  { label: 'Onboarding', path: '/onboarding', capability: 'positions.read', section: 'people' },
  {
    label: 'Find Trainers',
    path: '/find-trainers',
    capability: 'matching.read',
    section: 'people',
  },
  { label: 'Documents', path: '/documents', capability: 'trainers.read', section: 'people' },
  { label: 'Deboarding', path: '/deboarding', capability: 'deboarding.read', section: 'people' },
  { label: 'Talent Pool', path: '/pool', capability: 'pool.read', section: 'people' },

  // Who we deliver for, what it earned, what it cost.
  { label: 'Clients', path: '/clients', capability: 'clients.read', section: 'commercial' },
  { label: 'Margin', path: '/margin', capability: 'billing.read', section: 'commercial' },
  { label: 'Payroll', path: '/payroll', capability: 'payroll.read', section: 'commercial' },

  // Trainer self-service.
  {
    label: 'My Profile',
    path: '/my/profile',
    capability: 'trainers.upload_documents',
    section: 'yours',
  },
  // One screen rather than five: the punch, the month, the sessions taught, the
  // deliverables owed and the kit issued are all the same assignment.
  { label: 'My Work', path: '/my/work', capability: 'attendance.punch', section: 'yours' },
  { label: 'My Leave', path: '/my/leave', capability: 'leave.request', section: 'yours' },
  {
    label: 'My Reimbursements',
    path: '/my/reimbursements',
    capability: 'reimbursements.submit',
    section: 'yours',
  },

  { label: 'Audit Log', path: '/audit', capability: 'audit.read', section: 'admin' },
  { label: 'Users', path: '/users', capability: 'users.manage', section: 'admin' },
];

export function visibleNavItems(capabilities: readonly Capability[]): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.capability || capabilities.includes(item.capability));
}

/**
 * The sections a person actually has something in.
 *
 * Empty groups are dropped rather than rendered with a heading and nothing
 * under it — a trainer holds none of the delivery or commercial capabilities,
 * and four bare headings would be worse than the flat list this replaced.
 */
export function visibleNavSections(
  capabilities: readonly Capability[],
): { id: NavSection; label: string | null; items: NavItem[] }[] {
  const visible = visibleNavItems(capabilities);
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: visible.filter((item) => item.section === section.id),
  })).filter((section) => section.items.length > 0);
}
