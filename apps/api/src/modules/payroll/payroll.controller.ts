import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PAYROLL_EXPORT_LAYOUT_IDS,
  payrollExportLayout,
  payrollExportQuerySchema,
  payrollQuerySchema,
  type PayrollExportQuery,
  type PayrollQuery,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { sendCsv } from '../../common/csv.js';
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
  @ApiOperation({ summary: 'Hand the month to payroll, and record that it went' })
  async export(
    @Query(validate(payrollExportQuerySchema)) query: PayrollExportQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.payroll.export(query, user);
    sendCsv(response, file.filename, file.body);
  }

  @Get('exports')
  @RequireCapability('payroll.read')
  @ApiOperation({ summary: 'Every time a month has been handed over, newest first' })
  handoffs(@Query(validate(payrollExportQuerySchema)) query: PayrollExportQuery) {
    return this.payroll.handoffs(query.month);
  }

  @Get('export-layouts')
  @RequireCapability('payroll.read')
  @ApiOperation({ summary: 'The layouts a month can be exported in' })
  layouts() {
    return PAYROLL_EXPORT_LAYOUT_IDS.map((id) => ({
      id,
      label: payrollExportLayout(id).label,
      description: payrollExportLayout(id).description,
      columns: payrollExportLayout(id).columns.map((column) => column.header),
    }));
  }
}
