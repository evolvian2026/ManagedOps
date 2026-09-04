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
import { CurrentUser } from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import {
  contactPreferencesSchema,
  uuidSchema,
  type ContactPreferencesInput,
} from '@managedops/shared';
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

  @Get('preferences')
  @ApiOperation({ summary: 'Where phone messages go, and what would be sent there' })
  preferences(@CurrentUser('userId') userId: string) {
    return this.notifications.contactPreferences(userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Change your mobile number or turn phone messages off' })
  updatePreferences(
    @CurrentUser('userId') userId: string,
    @Body(validate(contactPreferencesSchema)) body: ContactPreferencesInput,
  ) {
    return this.notifications.updateContactPreferences(userId, body);
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
