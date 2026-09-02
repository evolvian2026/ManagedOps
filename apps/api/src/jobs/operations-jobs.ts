import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LEAVE_ESCALATION_HOURS, toIstDateString } from '@managedops/shared';
import { AttendanceService } from '../modules/operations/attendance.service.js';
import { LeaveService } from '../modules/operations/leave.service.js';
import { AssignmentContext } from '../modules/operations/assignment-context.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';

/**
 * The two jobs that keep delivery operations honest overnight.
 *
 * Both are idempotent by construction rather than by a flag: closing a day only
 * touches records whose current status permits the move, and escalating only
 * finds requests still sitting in `submitted`. A retry after a partial failure
 * picks up exactly what was left.
 */
@Injectable()
export class OperationsJobs {
  private readonly logger = new Logger(OperationsJobs.name);

  constructor(
    private readonly attendance: AttendanceService,
    private readonly leave: LeaveService,
    private readonly context: AssignmentContext,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Runs at 23:55 IST, so it closes the day it is still inside. Taking the date
   * from the clock rather than from "yesterday" keeps the job correct if it is
   * re-run manually, and the IST helper is what decides which day that is.
   */
  async closeAttendanceDay(now = new Date()): Promise<void> {
    const workDate = toIstDateString(now);
    const { missingPunchOut, absent } = await this.attendance.closeDay(workDate);
    if (missingPunchOut > 0 || absent > 0) {
      this.logger.log({ workDate, missingPunchOut, absent }, 'Closed the attendance day');
    }
  }

  /**
   * Moves leave the Project Lead has not decided within the window up to the
   * Manager and HR (spec 4.6). The lead keeps the request — escalation widens
   * who may decide, it does not take it away — because a lead who is simply
   * travelling should still be able to answer when they land.
   */
  async escalateStaleLeave(now = new Date()): Promise<number> {
    const due = await this.leave.dueForEscalation(now, LEAVE_ESCALATION_HOURS);
    const webBaseUrl = this.config.getOrThrow<string>('webBaseUrl');
    let escalated = 0;

    for (const request of due) {
      const { escalation } = await this.context.approvers(request.assignment.projectId);
      const recipients = escalation.filter(Boolean);
      if (recipients.length === 0) {
        // Nobody to escalate to. Leaving it submitted keeps it in the lead's
        // queue rather than parking it in a state with no owner.
        this.logger.warn(
          { leaveRequestId: request.id },
          'Leave is overdue but its project has no manager or HR to escalate to',
        );
        continue;
      }

      await this.leave.markEscalated(request.id);
      escalated += 1;

      await this.notifications.notify({
        userIds: recipients,
        type: 'leave_escalated',
        title: `Leave for ${request.assignment.trainer.user.name} is still undecided`,
        body:
          `${toIstDateString(request.startDate)} to ${toIstDateString(request.endDate)} ` +
          `on ${request.assignment.project.name} has been waiting ${LEAVE_ESCALATION_HOURS} hours. ` +
          `Either of you can decide it: ${webBaseUrl}/approvals`,
        entityType: 'LeaveRequest',
        entityId: request.id,
      });
    }

    if (escalated > 0) this.logger.log({ escalated }, 'Escalated undecided leave requests');
    return escalated;
  }
}
