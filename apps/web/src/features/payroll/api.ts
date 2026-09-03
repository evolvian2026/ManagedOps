import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** The month's pay inputs. */

export interface PayrollRow {
  trainerId: string;
  employeeCode: string;
  name: string;
  joiningDate: string | null;
  status: string;
  projects: string[];
  workingDaysInMonth: number;
  workingDays: number;
  payableDays: number;
  lopDays: number;
  leaveDays: number;
  monthlyGross: number;
  earnedGross: number;
  lopDeduction: number;
  reimbursements: number;
  finalSettlement: number;
  totalPayable: number;
  ready: boolean;
  blockers: string[];
}

export interface PayrollRegister {
  month: string;
  from: string;
  to: string;
  generatedAt: string;
  rows: PayrollRow[];
  totals: {
    people: number;
    ready: number;
    unresolved: number;
    earnedGross: number;
    lopDeduction: number;
    reimbursements: number;
    finalSettlement: number;
    totalPayable: number;
  };
}

export interface PayrollFilters {
  month: string;
  unresolvedOnly: boolean;
}

export function payrollSearch(filters: PayrollFilters): string {
  const search = new URLSearchParams({ month: filters.month });
  if (filters.unresolvedOnly) search.set('unresolvedOnly', 'true');
  return search.toString();
}

export function usePayrollRegister(filters: PayrollFilters) {
  return useQuery({
    queryKey: ['payroll', filters],
    queryFn: ({ signal }) =>
      api.get<PayrollRegister>(`/payroll/register?${payrollSearch(filters)}`, signal),
  });
}

/**
 * The month payroll is actually run for — the one that has finished.
 *
 * Opening on the current month would show a period whose attendance is by
 * definition incomplete, and every row would read as not ready for reasons
 * nobody can do anything about yet.
 */
export function lastCompleteMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1)).toISOString().slice(0, 7);
}
