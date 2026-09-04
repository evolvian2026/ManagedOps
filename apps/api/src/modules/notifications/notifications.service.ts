import { Injectable } from '@nestjs/common';
import {
  maskMobile,
  mobileMessagePurposes,
  paginationSchema,
  type ContactPreferencesInput,
  type NotificationType,
} from '@managedops/shared';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { NotFoundProblem } from '../../common/errors.js';
import { MailService } from './mail.service.js';
import { MobileMessageService, type MobileIntent } from './mobile.service.js';

export const notificationQuerySchema = paginationSchema
  .extend({ unreadOnly: z.enum(['true', 'false']).optional() })
  .strict();
export type NotificationQuery = z.infer<typeof notificationQuerySchema>;

export interface NotifyInput {
  userIds: string[];
  type: NotificationType;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  /** When set, the same message is also emailed to these addresses. */
  email?: { to: string; subject: string; text: string };
  /**
   * When set, the same message also goes to each recipient's phone.
   *
   * Deliberately not given a number: the caller names the event and the people,
   * and the messaging service decides whether each of them has a usable number
   * and wants messages there. A call site that passed its own number could send
   * one person's leave decision to another's phone.
   */
  mobile?: MobileIntent;
}

const SORTABLE = ['createdAt'] as const;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly mobile: MobileMessageService,
  ) {}

  async notify(input: NotifyInput): Promise<void> {
    const recipients = [...new Set(input.userIds)].filter(Boolean);
    if (recipients.length > 0) {
      await this.prisma.db.notification.createMany({
        data: recipients.map((userId) => ({
          id: newId(),
          userId,
          type: input.type,
          title: input.title,
          body: input.body,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
        })),
      });
    }
    if (input.email) await this.mail.send(input.email);
    if (input.mobile) {
      await this.mobile.send(recipients, input.mobile, {
        notificationType: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
      });
    }
  }

  async list(userId: string, query: NotificationQuery) {
    const where = {
      userId,
      ...(query.unreadOnly === 'true' ? { readAt: null } : {}),
    };
    const page = toPrismaPage(query, SORTABLE);
    const [data, total, unread] = await Promise.all([
      this.prisma.db.notification.findMany({ where, ...page }),
      this.prisma.db.notification.count({ where }),
      this.prisma.db.notification.count({ where: { userId, readAt: null } }),
    ]);
    const result = paginate(data, total, query);
    // The bell badge needs the unread count regardless of the current filter.
    return { ...result, meta: { ...result.meta, unread } };
  }

  async markRead(userId: string, notificationId: string): Promise<{ id: string; readAt: Date }> {
    // Scoped by userId so one user cannot mark another's notification read.
    const result = await this.prisma.db.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const exists = await this.prisma.db.notification.findFirst({
        where: { id: notificationId, userId },
      });
      if (!exists) throw new NotFoundProblem('That notification');
      return { id: notificationId, readAt: exists.readAt ?? new Date() };
    }
    return { id: notificationId, readAt: new Date() };
  }

  /**
   * What we would send to a phone, and where.
   *
   * The number comes back masked. This screen exists so somebody can check
   * their number is right, and the last four digits answer that without putting
   * a full mobile number into a page that might be over somebody's shoulder.
   */
  async contactPreferences(userId: string) {
    const user = await this.prisma.db.user.findUnique({
      where: { id: userId },
      select: { phone: true, mobileNotifications: true },
    });
    if (!user) throw new NotFoundProblem('That account');
    return {
      phone: user.phone,
      phoneMasked: user.phone ? maskMobile(user.phone) : null,
      mobileNotifications: user.mobileNotifications,
      purposes: mobileMessagePurposes(),
    };
  }

  async updateContactPreferences(userId: string, input: ContactPreferencesInput) {
    const phone = input.phone === undefined ? undefined : input.phone === '' ? null : input.phone;
    const user = await this.prisma.db.user.update({
      where: { id: userId },
      data: {
        ...(phone !== undefined ? { phone } : {}),
        ...(input.mobileNotifications !== undefined
          ? { mobileNotifications: input.mobileNotifications }
          : {}),
      },
      select: { phone: true, mobileNotifications: true },
    });
    return {
      phone: user.phone,
      phoneMasked: user.phone ? maskMobile(user.phone) : null,
      mobileNotifications: user.mobileNotifications,
      purposes: mobileMessagePurposes(),
    };
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.prisma.db.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}
