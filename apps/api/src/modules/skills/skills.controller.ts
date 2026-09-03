import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createSkillSchema,
  matchQuerySchema,
  setPositionSkillSchema,
  setTrainerSkillSchema,
  skillQuerySchema,
  updateSkillSchema,
  uuidSchema,
  type CreateSkillInput,
  type MatchQuery,
  type SetPositionSkillInput,
  type SetTrainerSkillInput,
  type SkillQuery,
  type UpdateSkillInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { sendCsv, toCsv } from '../../common/csv.js';
import { SkillsService } from './skills.service.js';
import { MatchingService } from './matching.service.js';

@ApiTags('skills')
@ApiBearerAuth()
@Audited('Skill')
@Controller('api/v1/skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @RequireCapability('skills.read')
  @ApiOperation({ summary: 'The skill catalogue' })
  list(@Query(validate(skillQuerySchema)) query: SkillQuery) {
    return this.skills.list(query);
  }

  @Post()
  @RequireCapability('skills.catalogue')
  @ApiOperation({ summary: 'Add a skill to the catalogue' })
  create(
    @Body(validate(createSkillSchema)) body: CreateSkillInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.skills.create(body, user);
  }

  @Patch(':id')
  @RequireCapability('skills.catalogue')
  @ApiOperation({ summary: 'Rename, recategorise or archive a skill' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateSkillSchema)) body: UpdateSkillInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.skills.update(id, body, user);
  }

  @Delete(':id')
  @RequireCapability('skills.catalogue')
  @ApiOperation({ summary: 'Delete a skill nobody claims' })
  remove(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.skills.remove(id, user);
  }
}

@ApiTags('skills')
@ApiBearerAuth()
@Audited('TrainerSkill')
@Controller('api/v1/trainers/:trainerId/skills')
export class TrainerSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @RequireCapability('skills.read')
  @ApiOperation({ summary: 'What this trainer can teach' })
  list(
    @Param('trainerId', validate(uuidSchema)) trainerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.skills.forTrainer(trainerId, user);
  }

  @Put()
  @RequireCapability('skills.manage')
  @ApiOperation({ summary: 'Add a skill to this profile, or update it' })
  set(
    @Param('trainerId', validate(uuidSchema)) trainerId: string,
    @Body(validate(setTrainerSkillSchema)) body: SetTrainerSkillInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.skills.setForTrainer(trainerId, body, user);
  }

  @Delete(':skillId')
  @RequireCapability('skills.manage')
  @ApiOperation({ summary: 'Take a skill off this profile' })
  remove(
    @Param('trainerId', validate(uuidSchema)) trainerId: string,
    @Param('skillId', validate(uuidSchema)) skillId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.skills.removeFromTrainer(trainerId, skillId, user);
  }
}

@ApiTags('skills')
@ApiBearerAuth()
@Audited('PositionSkill')
@Controller('api/v1/positions/:positionId/skills')
export class PositionSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @RequireCapability('positions.read')
  @ApiOperation({ summary: 'What this position needs' })
  list(
    @Param('positionId', validate(uuidSchema)) positionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.skills.forPosition(positionId, user);
  }

  @Put()
  @RequireCapability('positions.manage')
  @ApiOperation({ summary: 'Require a skill for this position, or change how' })
  set(
    @Param('positionId', validate(uuidSchema)) positionId: string,
    @Body(validate(setPositionSkillSchema)) body: SetPositionSkillInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.skills.setForPosition(positionId, body, user);
  }

  @Delete(':skillId')
  @RequireCapability('positions.manage')
  @ApiOperation({ summary: 'Stop requiring a skill for this position' })
  remove(
    @Param('positionId', validate(uuidSchema)) positionId: string,
    @Param('skillId', validate(uuidSchema)) skillId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.skills.removeFromPosition(positionId, skillId, user);
  }
}

@ApiTags('matching')
@ApiBearerAuth()
@Audited('Matching')
@Controller('api/v1/matching')
export class MatchingController {
  constructor(private readonly matching: MatchingService) {}

  @Get('trainers')
  @RequireCapability('matching.read')
  @ApiOperation({ summary: 'Who could do this work, ranked by fit and availability' })
  find(
    @Query(validate(matchQuerySchema)) query: MatchQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.matching.find(query, user);
  }

  @Get('trainers/export.csv')
  @RequireCapability('matching.read')
  @ApiOperation({ summary: 'Export the shortlist as CSV' })
  async export(
    @Query(validate(matchQuerySchema)) query: MatchQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const report = await this.matching.find(query, user);
    const body = toCsv(report.candidates, [
      { header: 'employee_code', value: (row) => row.employeeCode },
      { header: 'name', value: (row) => row.name },
      { header: 'fit_score', value: (row) => row.score },
      { header: 'meets_essentials', value: (row) => (row.eligible ? 'yes' : 'no') },
      { header: 'available_percent', value: (row) => row.availability.availablePercent },
      {
        header: 'available_from',
        value: (row) => row.availability.availableFrom ?? 'no end date agreed',
      },
      { header: 'why', value: (row) => row.reasons.join(' ') },
    ]);
    sendCsv(response, 'managedops-shortlist.csv', body);
  }
}
