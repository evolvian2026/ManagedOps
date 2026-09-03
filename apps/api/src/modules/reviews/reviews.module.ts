import { Module } from '@nestjs/common';
import { ReviewsController, TrainerReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

/**
 * What delivery was actually like.
 *
 * Exported because the point of collecting it is to put it in front of the
 * re-hire decision, which is made in the exit module.
 */
@Module({
  controllers: [ReviewsController, TrainerReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
