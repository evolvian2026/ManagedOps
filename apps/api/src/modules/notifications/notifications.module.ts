import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service.js';
import { MobileMessageService } from './mobile.service.js';
import {
  LogMessagingProvider,
  MessagingProvider,
  TwilioMessagingProvider,
} from './messaging.provider.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    MailService,
    LogMessagingProvider,
    TwilioMessagingProvider,
    {
      // One transport chosen at boot, so nothing above this layer branches on
      // which environment it is running in.
      provide: MessagingProvider,
      inject: [ConfigService, LogMessagingProvider, TwilioMessagingProvider],
      useFactory: (
        config: ConfigService,
        log: LogMessagingProvider,
        twilio: TwilioMessagingProvider,
      ): MessagingProvider =>
        config.getOrThrow<string>('messaging.provider') === 'twilio' ? twilio : log,
    },
    MobileMessageService,
    NotificationsService,
  ],
  exports: [MailService, MobileMessageService, NotificationsService],
})
export class NotificationsModule {}
