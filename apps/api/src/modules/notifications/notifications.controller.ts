import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { uuidSchema } from '@managedops/shared';
import {
  NotificationsService,
  notificationQuerySchema,
  type NotificationQuery,
} from './notifications.service.js';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "List the signed-in user's notifications" })
  list(
    @CurrentUser('userId') userId: string,
    @Query(validate(notificationQuerySchema)) query: NotificationQuery,
  ) {
    return this.notifications.list(userId, query);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one notification read' })
  markRead(@CurrentUser('userId') userId: string, @Param('id', validate(uuidSchema)) id: string) {
    return this.notifications.markRead(userId, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every unread notification read' })
  markAllRead(@CurrentUser('userId') userId: string) {
    return this.notifications.markAllRead(userId);
  }
}
