import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** A caller-supplied id is echoed back, but only if it is plausibly an id. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Assigns every request a trace id and echoes it in `X-Request-Id`.
 *
 * This is application middleware rather than a job the logger does, because the
 * id is part of the API's contract: every error response carries it, and it is
 * what correlates a user's bug report with the stack trace in the logs. Tying it
 * to the logging transport would mean errors lose their trace id anywhere the
 * logger is not mounted.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    const supplied = req.headers['x-request-id'];
    req.id =
      typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  }
}
