import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createReviewSchema,
  retractReviewSchema,
  reviewQuerySchema,
  uuidSchema,
  type CreateReviewInput,
  type RetractReviewInput,
  type ReviewQuery,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { ReviewsService } from './reviews.service.js';

@ApiTags('reviews')
@ApiBearerAuth()
@Audited('TrainerReview')
@Controller('api/v1/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @RequireCapability('reviews.read')
  @ApiOperation({ summary: 'Feedback the caller may see' })
  list(
    @Query(validate(reviewQuerySchema)) query: ReviewQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reviews.list(query, user);
  }

  @Post()
  @RequireCapability('reviews.write')
  @ApiOperation({ summary: 'Record what delivery was like' })
  create(
    @Body(validate(createReviewSchema)) body: CreateReviewInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reviews.create(body, user);
  }

  // No PATCH. A review is not editable by design: a correction is a new review
  // and a mistake is withdrawn, so the record of what was said survives.
  @Post(':id/retract')
  @RequireCapability('reviews.retract')
  // Withdrawing creates nothing, so it answers 200 rather than Nest's default
  // 201 for a POST.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a review, with a reason' })
  retract(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(retractReviewSchema)) body: RetractReviewInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reviews.retract(id, body, user);
  }
}

@ApiTags('reviews')
@ApiBearerAuth()
@Audited('TrainerReview')
@Controller('api/v1/trainers/:trainerId/reviews')
export class TrainerReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @RequireCapability('reviews.read')
  @ApiOperation({ summary: 'How this trainer is rated, summarised and listed' })
  async forTrainer(
    @Param('trainerId', validate(uuidSchema)) trainerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.reviews.forTrainer(trainerId, user);
    return { ...result, viewer: this.reviews.capabilities(user) };
  }
}
