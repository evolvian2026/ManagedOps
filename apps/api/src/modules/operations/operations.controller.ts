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
  assetQuerySchema,
  createAssetSchema,
  createDailyLogSchema,
  createDeliverableSchema,
  createFlagSchema,
  createLeaveSchema,
  createReimbursementSchema,
  dailyLogQuerySchema,
  decideLeaveSchema,
  decideReimbursementSchema,
  deliverableQuerySchema,
  flagQuerySchema,
  issueAssetSchema,
  leaveQuerySchema,
  markPaidSchema,
  reimbursementQuerySchema,
  resolveFlagSchema,
  returnAssetSchema,
  unlockDailyLogSchema,
  updateDailyLogSchema,
  updateDeliverableSchema,
  uuidSchema,
  type AssetQuery,
  type CreateAssetInput,
  type CreateDailyLogInput,
  type CreateDeliverableInput,
  type CreateFlagInput,
  type CreateLeaveInput,
  type CreateReimbursementInput,
  type DailyLogQuery,
  type DecideLeaveInput,
  type DecideReimbursementInput,
  type DeliverableQuery,
  type FlagQuery,
  type IssueAssetInput,
  type LeaveQuery,
  type MarkPaidInput,
  type ReimbursementQuery,
  type ResolveFlagInput,
  type ReturnAssetInput,
  type UnlockDailyLogInput,
  type UpdateDailyLogInput,
  type UpdateDeliverableInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireAnyCapability,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { AssetsService } from './assets.service.js';
import { DailyLogService } from './dailylog.service.js';
import { DeliverablesService } from './deliverables.service.js';
import { FlagsService } from './flags.service.js';
import { LeaveService } from './leave.service.js';
import { ReimbursementsService } from './reimbursements.service.js';

const assignmentQuery = z.object({ assignmentId: uuidSchema.optional() }).strict();

/* ------------------------------------------------------------------- leave */

@ApiTags('leave')
@ApiBearerAuth()
@Audited('LeaveRequest')
@Controller('api/v1/leave-requests')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Post()
  @RequireCapability('leave.request')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request leave' })
  create(
    @Body(validate(createLeaveSchema)) body: CreateLeaveInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.leave.create(body, user);
  }

  // Before ':id' so "balance" is never parsed as an identifier.
  @Get('balance')
  @RequireAnyCapability('leave.request', 'leave.approve')
  @ApiOperation({ summary: 'Allowance, used and remaining for an assignment' })
  balance(
    @Query(validate(assignmentQuery)) query: { assignmentId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.leave.balance(user, query.assignmentId);
  }

  @Get()
  @RequireAnyCapability('leave.request', 'leave.approve')
  @ApiOperation({ summary: 'Leave requests: an approver sees their queue, a trainer their own' })
  list(
    @Query(validate(leaveQuerySchema)) query: LeaveQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.leave.list(query, user);
  }

  @Get(':id')
  @RequireAnyCapability('leave.request', 'leave.approve')
  @ApiOperation({ summary: 'One leave request' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.leave.get(id, user);
  }

  @Post(':id/decide')
  @RequireCapability('leave.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject, writing the attendance days' })
  decide(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(decideLeaveSchema)) body: DecideLeaveInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.leave.decide(id, body, user);
  }

  @Post(':id/cancel')
  @RequireCapability('leave.request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a request before it starts' })
  cancel(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.leave.cancel(id, user);
  }
}

/* --------------------------------------------------------------- daily log */

@ApiTags('daily-logs')
@ApiBearerAuth()
@Audited('DailyLog')
@Controller('api/v1/daily-logs')
export class DailyLogController {
  constructor(private readonly logs: DailyLogService) {}

  @Post()
  @RequireCapability('dailylogs.write')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record a teaching session' })
  create(
    @Body(validate(createDailyLogSchema)) body: CreateDailyLogInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.logs.create(body, user);
  }

  @Get()
  @RequireCapability('dailylogs.read')
  @ApiOperation({ summary: 'Sessions, scoped to what the caller may see' })
  list(
    @Query(validate(dailyLogQuerySchema)) query: DailyLogQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.logs.list(query, user);
  }

  @Patch(':id')
  @RequireCapability('dailylogs.write')
  @ApiOperation({ summary: 'Correct an unlocked session' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateDailyLogSchema)) body: UpdateDailyLogInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.logs.update(id, body, user);
  }

  @Post(':id/unlock')
  @RequireCapability('dailylogs.unlock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock one session for correction; the reason is audited' })
  unlock(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(unlockDailyLogSchema)) body: UnlockDailyLogInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.logs.unlock(id, body, user);
  }
}

/* ------------------------------------------------------------ deliverables */

@ApiTags('deliverables')
@ApiBearerAuth()
@Audited('Deliverable')
@Controller('api/v1/deliverables')
export class DeliverablesController {
  constructor(private readonly deliverables: DeliverablesService) {}

  @Post()
  @RequireCapability('deliverables.write')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a syllabus item or other duty' })
  create(
    @Body(validate(createDeliverableSchema)) body: CreateDeliverableInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliverables.create(body, user);
  }

  @Get()
  @RequireCapability('deliverables.read')
  @ApiOperation({ summary: 'The checklist for an assignment' })
  list(
    @Query(validate(deliverableQuerySchema)) query: DeliverableQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliverables.list(query, user);
  }

  @Patch(':id')
  @RequireCapability('deliverables.write')
  @ApiOperation({ summary: 'Mark progress or attach evidence' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateDeliverableSchema)) body: UpdateDeliverableInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliverables.update(id, body, user);
  }
}

/* ------------------------------------------------------------------ assets */

@ApiTags('assets')
@ApiBearerAuth()
@Audited('Asset')
@Controller('api/v1/assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post()
  @RequireCapability('assets.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register an asset' })
  create(
    @Body(validate(createAssetSchema)) body: CreateAssetInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assets.create(body, user);
  }

  @Get('mine')
  @RequireCapability('assets.read')
  @ApiOperation({ summary: 'What is currently in the caller’s hands' })
  mine(
    @Query(validate(assignmentQuery)) query: { assignmentId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assets.issuedTo(user, query.assignmentId);
  }

  @Get()
  @RequireCapability('assets.read')
  @ApiOperation({ summary: 'The register, with who currently holds each item' })
  list(
    @Query(validate(assetQuerySchema)) query: AssetQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assets.list(query, user);
  }

  @Post(':id/issue')
  @RequireCapability('assets.manage')
  @Audited('AssetIssue')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Issue an asset against an assignment' })
  issue(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(issueAssetSchema)) body: IssueAssetInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assets.issue(id, body, user);
  }
}

@ApiTags('assets')
@ApiBearerAuth()
@Audited('AssetIssue')
@Controller('api/v1/asset-issues')
export class AssetIssuesController {
  constructor(private readonly assets: AssetsService) {}

  @Post(':id/return')
  @RequireCapability('assets.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return an issued asset, reconciling the serial' })
  return(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(returnAssetSchema)) body: ReturnAssetInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assets.returnIssue(id, body, user);
  }
}

/* ---------------------------------------------------------- reimbursements */

@ApiTags('reimbursements')
@ApiBearerAuth()
@Audited('Reimbursement')
@Controller('api/v1/reimbursements')
export class ReimbursementsController {
  constructor(private readonly claims: ReimbursementsService) {}

  @Post()
  @RequireCapability('reimbursements.submit')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a claim with its proof' })
  create(
    @Body(validate(createReimbursementSchema)) body: CreateReimbursementInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.claims.create(body, user);
  }

  @Get()
  @RequireAnyCapability('reimbursements.submit', 'reimbursements.approve')
  @ApiOperation({ summary: 'Claims: an approver sees the queue, a trainer their own' })
  list(
    @Query(validate(reimbursementQuerySchema)) query: ReimbursementQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.claims.list(query, user);
  }

  @Get(':id')
  @RequireAnyCapability('reimbursements.submit', 'reimbursements.approve')
  @ApiOperation({ summary: 'One claim' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.claims.get(id, user);
  }

  @Post(':id/decide')
  @RequireCapability('reimbursements.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject; above ₹10,000 needs a Manager' })
  decide(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(decideReimbursementSchema)) body: DecideReimbursementInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.claims.decide(id, body, user);
  }

  @Post(':id/mark-paid')
  @RequireCapability('reimbursements.mark_paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record that the money moved' })
  markPaid(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(markPaidSchema)) body: MarkPaidInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.claims.markPaid(id, body, user);
  }
}

/* ------------------------------------------------------------------- flags */

@ApiTags('flags')
@ApiBearerAuth()
@Audited('Flag')
@Controller('api/v1/flags')
export class FlagsController {
  constructor(private readonly flags: FlagsService) {}

  @Post()
  @RequireCapability('flags.raise')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Raise a concern; the project’s Manager and HR are notified' })
  create(
    @Body(validate(createFlagSchema)) body: CreateFlagInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.flags.create(body, user);
  }

  @Get()
  @RequireAnyCapability('flags.raise', 'flags.resolve')
  @ApiOperation({ summary: 'The flag queue' })
  list(@Query(validate(flagQuerySchema)) query: FlagQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.flags.list(query, user);
  }

  @Post(':id/acknowledge')
  @RequireCapability('flags.resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Say somebody has picked this up' })
  acknowledge(
    @Param('id', validate(uuidSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.flags.acknowledge(id, user);
  }

  @Post(':id/resolve')
  @RequireCapability('flags.resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record the action taken and close it' })
  resolve(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(resolveFlagSchema)) body: ResolveFlagInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.flags.resolve(id, body, user);
  }
}
