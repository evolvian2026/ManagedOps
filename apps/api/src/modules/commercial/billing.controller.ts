import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { marginQuerySchema, uuidSchema, type MarginQuery } from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { sendCsv, toCsv } from '../../common/csv.js';
import { BillingService } from './billing.service.js';

@ApiTags('billing')
@ApiBearerAuth()
@Audited('Billing')
@Controller('api/v1/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('margin')
  @RequireCapability('billing.read')
  @ApiOperation({ summary: 'Revenue, cost and margin for a period' })
  margin(
    @Query(validate(marginQuerySchema)) query: MarginQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.report(query, user);
  }

  @Get('margin/export.csv')
  @RequireCapability('billing.read')
  @ApiOperation({ summary: 'Export the margin report as CSV' })
  async export(
    @Query(validate(marginQuerySchema)) query: MarginQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const report = await this.billing.report(query, user);
    const body = toCsv(report.rows, [
      { header: 'name', value: (row) => row.label },
      { header: 'reference', value: (row) => row.sublabel },
      { header: 'billable_days', value: (row) => row.billableDays },
      { header: 'revenue_inr', value: (row) => row.revenue },
      { header: 'salary_cost_inr', value: (row) => row.salaryCost },
      { header: 'reimbursements_inr', value: (row) => row.reimbursements },
      { header: 'total_cost_inr', value: (row) => row.cost },
      { header: 'margin_inr', value: (row) => row.margin },
      { header: 'margin_percent', value: (row) => row.marginPercent },
      { header: 'assignments_without_a_rate', value: (row) => row.unbilledAssignments },
    ]);
    sendCsv(response, `managedops-margin-${report.from}-to-${report.to}.csv`, body);
  }

  @Get('margin/project/:id')
  @RequireCapability('billing.read')
  @ApiOperation({ summary: 'One project’s margin, broken down by trainer' })
  forProject(
    @Param('id', validate(uuidSchema)) id: string,
    @Query(validate(marginQuerySchema)) query: MarginQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billing.forProject(id, query, user);
  }
}
