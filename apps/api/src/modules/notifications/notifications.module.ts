import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [MailService, NotificationsService],
  exports: [MailService, NotificationsService],
})
export class NotificationsModule {}
