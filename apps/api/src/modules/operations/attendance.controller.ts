import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  attendanceQuerySchema,
  correctionQuerySchema,
  decideCorrectionSchema,
  punchInSchema,
  punchOutSchema,
  requestCorrectionSchema,
  uuidSchema,
  type AttendanceQuery,
  type CorrectionQuery,
  type DecideCorrectionInput,
  type PunchInInput,
  type PunchOutInput,
  type RequestCorrectionInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { AttendanceService } from './attendance.service.js';

const calendarQuerySchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/, 'Expected a month as YYYY-MM'),
    assignmentId: uuidSchema.optional(),
  })
  .strict();

@ApiTags('attendance')
@ApiBearerAuth()
@Audited('AttendanceRecord')
@Controller('api/v1/attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('punch-in')
  @RequireCapability('attendance.punch')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start the working day' })
  punchIn(
    @Body(validate(punchInSchema)) body: PunchInInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attendance.punchIn(body, user);
  }

  @Post('punch-out')
  @RequireCapability('attendance.punch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close the working day' })
  punchOut(
    @Body(validate(punchOutSchema)) body: PunchOutInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attendance.punchOut(body, user);
  }

  // Declared before ':id' routes so "today" is never read as an identifier.
  @Get('today')
  @RequireCapability('attendance.punch')
  @ApiOperation({ summary: 'Which punch is available, and if none, why not' })
  today(@CurrentUser() user: AuthenticatedUser) {
    return this.attendance.today(user);
  }

  @Get('calendar')
  @RequireCapability('attendance.read')
  @ApiOperation({ summary: 'A month of one assignment, every date accounted for' })
  calendar(
    @Query(validate(calendarQuerySchema)) query: z.infer<typeof calendarQuerySchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attendance.calendar(query.month, user, query.assignmentId);
  }

  @Get('corrections')
  @RequireCapability('attendance.corrections.approve')
  @ApiOperation({ summary: 'Corrections waiting on this approver' })
  listCorrections(
    @Query(validate(correctionQuerySchema)) query: CorrectionQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attendance.listCorrections(query, user);
  }

  @Post('corrections/:id/decide')
  @RequireCapability('attendance.corrections.approve')
  @Audited('AttendanceCorrection')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a correction' })
  decideCorrection(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(decideCorrectionSchema)) body: DecideCorrectionInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attendance.decideCorrection(id, body, user);
  }

  @Get()
  @RequireCapability('attendance.read')
  @ApiOperation({ summary: 'Attendance records, scoped to what the caller may see' })
  list(
    @Query(validate(attendanceQuerySchema)) query: AttendanceQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attendance.list(query, user);
  }

  @Post(':id/corrections')
  @RequireCapability('attendance.punch')
  @Audited('AttendanceCorrection')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ask for a day to be corrected' })
  requestCorrection(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(requestCorrectionSchema)) body: RequestCorrectionInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attendance.requestCorrection(id, body, user);
  }
}
