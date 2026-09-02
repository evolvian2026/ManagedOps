import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  interviewOutcomeSchema,
  interviewQuerySchema,
  rescheduleInterviewSchema,
  scheduleInterviewSchema,
  updateInterviewSchema,
  uuidSchema,
  type InterviewOutcomeInput,
  type InterviewQuery,
  type RescheduleInterviewInput,
  type ScheduleInterviewInput,
  type UpdateInterviewInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { InterviewsService } from './interviews.service.js';

const cancelSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

@ApiTags('interviews')
@ApiBearerAuth()
@Audited('Interview')
@Controller('api/v1/interviews')
export class InterviewsController {
  constructor(private readonly interviews: InterviewsService) {}

  // Declared before ':id' so "pipeline" is never parsed as an identifier.
  @Get('pipeline')
  @RequireCapability('interviews.read')
  @ApiOperation({ summary: 'Per-position pipeline counts for the interview board' })
  pipeline(@CurrentUser() user: AuthenticatedUser) {
    return this.interviews.pipeline(user);
  }

  @Get()
  @RequireCapability('interviews.read')
  @ApiOperation({ summary: 'List interviews, scoped to what the caller may see' })
  list(
    @Query(validate(interviewQuerySchema)) query: InterviewQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.interviews.list(query, user);
  }

  @Get(':id')
  @RequireCapability('interviews.read')
  @ApiOperation({ summary: 'One interview' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.interviews.get(id, user);
  }

  @Post()
  @RequireCapability('interviews.schedule')
  @ApiOperation({ summary: 'Schedule an interview and notify the candidate' })
  schedule(
    @Body(validate(scheduleInterviewSchema)) body: ScheduleInterviewInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.interviews.schedule(body, user);
  }

  @Patch(':id')
  @RequireCapability('interviews.schedule')
  @ApiOperation({ summary: 'Change the time, link or interviewer of a booked interview' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateInterviewSchema)) body: UpdateInterviewInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.interviews.update(id, body, user);
  }

  @Post(':id/outcome')
  @RequireCapability('interviews.record_outcome')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record the result; selecting moves the candidate to the offer stage' })
  outcome(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(interviewOutcomeSchema)) body: InterviewOutcomeInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.interviews.recordOutcome(id, body, user);
  }

  @Post(':id/reschedule')
  @RequireCapability('interviews.schedule')
  @ApiOperation({ summary: 'Book a replacement round, keeping the missed one on record' })
  reschedule(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(rescheduleInterviewSchema)) body: RescheduleInterviewInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.interviews.reschedule(id, body, user);
  }

  @Post(':id/missed')
  @RequireCapability('interviews.schedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark an interview as missed' })
  missed(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.interviews.markMissed(id, user);
  }

  @Post(':id/cancel')
  @RequireCapability('interviews.schedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an interview' })
  cancel(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(cancelSchema)) body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.interviews.cancel(id, body.reason, user);
  }
}
