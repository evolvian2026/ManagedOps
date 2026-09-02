import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { FilesModule } from '../files/files.module.js';
import { AssignmentContext } from './assignment-context.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { AssetsService } from './assets.service.js';
import { DailyLogService } from './dailylog.service.js';
import { DeliverablesService } from './deliverables.service.js';
import { FlagsService } from './flags.service.js';
import { LeaveService } from './leave.service.js';
import { ReimbursementsService } from './reimbursements.service.js';
import {
  AssetIssuesController,
  AssetsController,
  DailyLogController,
  DeliverablesController,
  FlagsController,
  LeaveController,
  ReimbursementsController,
} from './operations.controller.js';

/**
 * Delivery operations: everything that happens between a trainer joining a
 * project and leaving it. They live in one module because they share one
 * question — which assignment is this about — answered once by
 * `AssignmentContext` rather than seven slightly different ways.
 */
@Module({
  imports: [NotificationsModule, FilesModule],
  controllers: [
    AttendanceController,
    LeaveController,
    DailyLogController,
    DeliverablesController,
    AssetsController,
    AssetIssuesController,
    ReimbursementsController,
    FlagsController,
  ],
  providers: [
    AssignmentContext,
    AttendanceService,
    LeaveService,
    DailyLogService,
    DeliverablesService,
    AssetsService,
    ReimbursementsService,
    FlagsService,
  ],
  exports: [AttendanceService, LeaveService, AssetsService, AssignmentContext],
})
export class OperationsModule {}
