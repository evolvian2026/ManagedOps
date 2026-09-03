import { Module } from '@nestjs/common';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { WorkingDaysService } from '../../common/working-days.js';

/**
 * The commercial side: who the work is for, and what it is worth.
 *
 * Clients and billing sit in one module because they are one concern seen from
 * two angles — the directory carries the contract, the report reads what that
 * contract actually earned.
 */
@Module({
  controllers: [ClientsController, BillingController],
  providers: [ClientsService, BillingService, WorkingDaysService],
  exports: [ClientsService, BillingService],
})
export class CommercialModule {}
