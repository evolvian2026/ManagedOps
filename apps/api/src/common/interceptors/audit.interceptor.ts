import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { tap } from 'rxjs';
import { AUDIT_ACTION_KEY, SKIP_AUDIT_KEY, type AuthenticatedUser } from '../decorators/index.js';
import { AuditService } from '../../modules/audit/audit.service.js';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Never persist a credential into the audit trail. */
const SENSITIVE_FIELDS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'refreshToken',
  'accessToken',
]);

/**
 * Records an audit entry for every successful state-mutating request. Attaching
 * this once, globally, is what makes "every mutation is audited" true by
 * construction rather than by each service remembering to call the logger.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; id?: string }>();

    if (!MUTATING_METHODS.has(request.method)) return next.handle();

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    const entityType =
      this.reflector.getAllAndOverride<string | undefined>(AUDIT_ACTION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? context.getClass().name.replace(/Controller$/, '');

    const action = `${request.method} ${request.route?.path ?? request.url}`;

    return next.handle().pipe(
      tap({
        next: (result) => {
          const entityId =
            (result as { id?: string } | undefined)?.id ??
            (typeof request.params?.id === 'string' ? request.params.id : undefined);

          // Auditing must never break the request it is recording.
          void this.audit
            .record({
              actorUserId: request.user?.userId ?? null,
              action,
              entityType,
              entityId: entityId ?? null,
              after: redact(request.body),
              ip: request.ip,
              userAgent: request.headers['user-agent'],
              requestId: typeof request.id === 'string' ? request.id : undefined,
            })
            .catch((error: unknown) => {
              this.logger.error({ err: error, action }, 'Failed to write audit entry');
            });
        },
      }),
    );
  }
}

function redact(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_FIELDS.has(key) ? '[redacted]' : entry;
  }
  return output;
}
