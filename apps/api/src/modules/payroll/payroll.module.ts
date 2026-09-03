import { Module } from '@nestjs/common';
import { PayrollController } from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';
import { WorkingDaysService } from '../../common/working-days.js';

/**
 * The month's pay inputs.
 *
 * Deliberately a register and not a payroll run: it states what ManagedOps
 * knows and hands it on. Statutory deductions belong to whoever files them.
 */
@Module({
  controllers: [PayrollController],
  providers: [PayrollService, WorkingDaysService],
  exports: [PayrollService],
})
export class PayrollModule {}
