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
  applicationQuerySchema,
  candidateQuerySchema,
  createApplicationSchema,
  createCandidateSchema,
  screenApplicationSchema,
  updateCandidateSchema,
  uuidSchema,
  type ApplicationQuery,
  type CandidateQuery,
  type CreateApplicationInput,
  type CreateCandidateInput,
  type ScreenApplicationInput,
  type UpdateCandidateInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { ApplicationsService } from './applications.service.js';
import { CandidatesService } from './candidates.service.js';

const withdrawSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

@ApiTags('candidates')
@ApiBearerAuth()
@Audited('Candidate')
@Controller('api/v1/candidates')
export class CandidatesController {
  constructor(private readonly candidates: CandidatesService) {}

  @Get()
  @RequireCapability('candidates.read')
  @ApiOperation({ summary: 'List candidates' })
  list(
    @Query(validate(candidateQuerySchema)) query: CandidateQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.candidates.list(query, user);
  }

  @Get(':id')
  @RequireCapability('candidates.read')
  @ApiOperation({ summary: 'One candidate, with every application they have made' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.candidates.get(id, user);
  }

  @Post()
  @RequireCapability('candidates.manage')
  @ApiOperation({ summary: 'Add a candidate, optionally applying them to a position' })
  create(
    @Body(validate(createCandidateSchema)) body: CreateCandidateInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.candidates.create(body, user);
  }

  @Patch(':id')
  @RequireCapability('candidates.manage')
  @ApiOperation({ summary: 'Update a candidate' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateCandidateSchema)) body: UpdateCandidateInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.candidates.update(id, body, user);
  }
}

@ApiTags('applications')
@ApiBearerAuth()
@Audited('Application')
@Controller('api/v1/applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Get()
  @RequireCapability('candidates.read')
  @ApiOperation({ summary: 'List applications, filtered by position, project or status' })
  list(
    @Query(validate(applicationQuerySchema)) query: ApplicationQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.applications.list(query, user);
  }

  @Get(':id')
  @RequireCapability('candidates.read')
  @ApiOperation({ summary: 'One application, with its interviews and offers' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.applications.get(id, user);
  }

  @Post()
  @RequireCapability('candidates.manage')
  @ApiOperation({ summary: 'Apply an existing candidate to a position' })
  create(
    @Body(validate(createApplicationSchema)) body: CreateApplicationInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.applications.create(body, user);
  }

  @Post(':id/screen')
  @RequireCapability('applications.screen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record the screening call outcome, which routes the applicant' })
  screen(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(screenApplicationSchema)) body: ScreenApplicationInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.applications.screen(id, body, user);
  }

  @Post(':id/withdraw')
  @RequireCapability('candidates.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close an application because the candidate pulled out' })
  withdraw(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(withdrawSchema)) body: { reason?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.applications.withdraw(id, body.reason, user);
  }
}
