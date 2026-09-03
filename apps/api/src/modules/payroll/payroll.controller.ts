import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { payrollQuerySchema, type PayrollQuery } from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { sendCsv, toCsv } from '../../common/csv.js';
import { PayrollService } from './payroll.service.js';

@ApiTags('payroll')
@ApiBearerAuth()
@Audited('Payroll')
@Controller('api/v1/payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('register')
  @RequireCapability('payroll.read')
  @ApiOperation({ summary: 'A month’s pay inputs, one row per person' })
  register(
    @Query(validate(payrollQuerySchema)) query: PayrollQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payroll.register(query, user);
  }

  @Get('register/export.csv')
  @RequireCapability('payroll.read')
  @ApiOperation({ summary: 'The register as a CSV for the payroll system' })
  async export(
    @Query(validate(payrollQuerySchema)) query: PayrollQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const register = await this.payroll.register(query, user);

    // Column names are flat and explicit because something else imports this.
    // A header a payroll clerk has to interpret is a column they will map wrong.
    const body = toCsv(register.rows, [
      { header: 'employee_code', value: (row) => row.employeeCode },
      { header: 'name', value: (row) => row.name },
      { header: 'month', value: () => register.month },
      { header: 'working_days_in_month', value: (row) => row.workingDaysInMonth },
      { header: 'payable_days', value: (row) => row.payableDays },
      { header: 'leave_days_paid', value: (row) => row.leaveDays },
      { header: 'loss_of_pay_days', value: (row) => row.lopDays },
      { header: 'monthly_gross_inr', value: (row) => row.monthlyGross },
      { header: 'loss_of_pay_inr', value: (row) => row.lopDeduction },
      { header: 'earned_gross_inr', value: (row) => row.earnedGross },
      { header: 'reimbursements_inr', value: (row) => row.reimbursements },
      { header: 'final_settlement_inr', value: (row) => row.finalSettlement },
      { header: 'total_payable_inr', value: (row) => row.totalPayable },
      { header: 'ready_to_pay', value: (row) => (row.ready ? 'yes' : 'no') },
      // Exported rather than hidden: a row that is not ready has to say why in
      // the file itself, or the reason is lost the moment it leaves here.
      { header: 'unresolved', value: (row) => row.blockers.join(' ') },
    ]);

    sendCsv(response, `managedops-payroll-${register.month}.csv`, body);
  }
}
