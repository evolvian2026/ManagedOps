import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { RecruitmentModule } from '../recruitment/recruitment.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { DashboardController, DeboardingController, PoolController } from './exit.controller.js';
import { DashboardService } from './dashboard.service.js';
import { DeboardingService } from './deboarding.service.js';
import { PoolService } from './pool.service.js';

/**
 * How somebody leaves, and how they come back.
 *
 * Deboarding and the Talent Pool belong together because completing the first
 * is what puts a person into the second — the pool being a query over that
 * state rather than a flag anybody has to remember to set. The dashboard sits
 * here too: it is the one screen that reads across every module, and giving it
 * a home of its own would mean a module that owns nothing.
 */
@Module({
  imports: [NotificationsModule, OperationsModule, RecruitmentModule, ReviewsModule],
  controllers: [DeboardingController, PoolController, DashboardController],
  providers: [DeboardingService, PoolService, DashboardService],
  exports: [DeboardingService, PoolService],
})
export class ExitModule {}
