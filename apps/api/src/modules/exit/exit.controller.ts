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
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  considerForPositionSchema,
  createDeboardingSchema,
  deboardingQuerySchema,
  poolQuerySchema,
  updateDeboardingSchema,
  uuidSchema,
  type ConsiderForPositionInput,
  type CreateDeboardingInput,
  type DeboardingQuery,
  type PoolQuery,
  type UpdateDeboardingInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { sendCsv, toCsv } from '../../common/csv.js';
import { EXPORT_PAGE_SIZE } from '../../common/export.js';
import { DashboardService } from './dashboard.service.js';
import { DeboardingService } from './deboarding.service.js';
import { PoolService } from './pool.service.js';

@ApiTags('deboarding')
@ApiBearerAuth()
@Audited('Deboarding')
@Controller('api/v1/deboardings')
export class DeboardingController {
  constructor(private readonly deboardings: DeboardingService) {}

  @Post()
  @RequireCapability('deboarding.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start winding an assignment down' })
  create(
    @Body(validate(createDeboardingSchema)) body: CreateDeboardingInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deboardings.create(body, user);
  }

  @Get()
  @RequireCapability('deboarding.read')
  @ApiOperation({ summary: 'Deboardings, scoped to what the caller may see' })
  list(
    @Query(validate(deboardingQuerySchema)) query: DeboardingQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deboardings.list(query, user);
  }

  // Before ':id' so "export.csv" is never parsed as an identifier.
  @Get('export.csv')
  @RequireCapability('deboarding.read')
  @ApiOperation({ summary: 'Export the filtered deboardings as CSV' })
  async export(
    @Query(validate(deboardingQuerySchema)) query: DeboardingQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.deboardings.list(
      { ...query, page: 1, pageSize: EXPORT_PAGE_SIZE },
      user,
    );
    const body = toCsv(result.data, [
      { header: 'employee_code', value: (row) => row.assignment.trainer.employeeCode },
      { header: 'name', value: (row) => row.assignment.trainer.user.name },
      { header: 'project', value: (row) => row.assignment.project.name },
      { header: 'last_working_day', value: (row) => row.lastWorkingDay },
      { header: 'reason', value: (row) => row.reason },
      { header: 'status', value: (row) => row.status },
      { header: 'assets_reconciled', value: (row) => row.assetsReconciled },
      { header: 'fnf_status', value: (row) => row.fnfStatus },
      { header: 'fnf_amount', value: (row) => row.fnfAmount },
      { header: 'rehire_eligible', value: (row) => row.assignment.trainer.rehireEligible },
      { header: 'completed_at', value: (row) => row.completedAt },
    ]);
    sendCsv(response, 'managedops-deboardings.csv', body);
  }

  @Get(':id')
  @RequireCapability('deboarding.read')
  @ApiOperation({ summary: 'One deboarding, with what is blocking it' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.deboardings.get(id, user);
  }

  @Patch(':id')
  @RequireCapability('deboarding.manage')
  @ApiOperation({ summary: 'Record progress on the checklist' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateDeboardingSchema)) body: UpdateDeboardingInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deboardings.update(id, body, user);
  }

  @Post(':id/complete')
  @RequireCapability('deboarding.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish it — assets reconciled and the settlement closed' })
  complete(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.deboardings.complete(id, user);
  }
}

@ApiTags('pool')
@ApiBearerAuth()
@Audited('Application')
@Controller('api/v1/pool')
export class PoolController {
  constructor(private readonly pool: PoolService) {}

  @Get()
  @RequireCapability('pool.read')
  @ApiOperation({ summary: 'Everyone worth calling again — a query, not a table' })
  list(@Query(validate(poolQuerySchema)) query: PoolQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.pool.list(query, user);
  }

  @Get('export.csv')
  @RequireCapability('pool.read')
  @ApiOperation({ summary: 'Export the filtered pool as CSV' })
  async export(
    @Query(validate(poolQuerySchema)) query: PoolQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.pool.list({ ...query, page: 1, pageSize: EXPORT_PAGE_SIZE }, user);
    const body = toCsv(result.data, [
      { header: 'name', value: (row) => row.name },
      { header: 'email', value: (row) => row.email },
      { header: 'phone', value: (row) => row.phone },
      { header: 'source', value: (row) => row.source },
      { header: 'worked_before', value: (row) => row.workedBefore },
      { header: 'employee_code', value: (row) => row.employeeCode },
      { header: 'last_status', value: (row) => row.lastStatus },
      { header: 'last_reason', value: (row) => row.lastReason },
      { header: 'last_position', value: (row) => row.lastPosition?.title },
      { header: 'last_project', value: (row) => row.lastProject?.name },
      { header: 'last_seen', value: (row) => row.lastSeenAt },
    ]);
    sendCsv(response, 'managedops-talent-pool.csv', body);
  }

  @Post(':id/create-application')
  @RequireCapability('pool.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Put a pool entry forward for an open position' })
  consider(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(considerForPositionSchema)) body: ConsiderForPositionInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.pool.considerForPosition(id, body, user);
  }
}

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('api/v1/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Tiles, the queue waiting on this user, and recent activity' })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboard.summary(user);
  }
}
