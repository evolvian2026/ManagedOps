import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ProblemDetails } from '@managedops/shared';
import { IllegalTransitionError } from '@managedops/shared';
import { Prisma } from '@prisma/client';
import { ProblemException } from '../errors.js';

const TYPE_BASE = 'https://managedops.app/errors';

/**
 * The single exit point for every error. Known failures keep their specific
 * type and detail; anything unexpected becomes a bare 500 carrying only a trace
 * id, with the stack going to the logs under that same id.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();
    const traceId = typeof request.id === 'string' ? request.id : undefined;

    const problem = this.toProblem(exception, request);
    if (problem.status >= 500) {
      this.logger.error(
        { traceId, path: request.url, err: exception },
        'Unhandled error while serving request',
      );
    }

    response
      .status(problem.status)
      .type('application/problem+json')
      .json({ ...problem, traceId });
  }

  private toProblem(exception: unknown, request: Request): ProblemDetails {
    if (exception instanceof ProblemException) {
      return exception.getResponse() as ProblemDetails;
    }

    // An illegal lifecycle move is a business-rule conflict, and the message
    // already names both states.
    if (exception instanceof IllegalTransitionError) {
      return {
        type: `${TYPE_BASE}/illegal-transition`,
        title: 'Request conflicts with a business rule',
        status: HttpStatus.CONFLICT,
        detail: exception.message,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const detail =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      return {
        type: `${TYPE_BASE}/${status === 404 ? 'not-found' : 'request-failed'}`,
        title: status === 404 ? 'Not found' : 'Request failed',
        status,
        detail: Array.isArray(detail) ? detail.join('; ') : detail,
      };
    }

    return {
      type: `${TYPE_BASE}/internal`,
      title: 'Something went wrong',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: `An unexpected error occurred while handling ${request.method} ${request.url}. Quote the trace id when reporting it.`,
    };
  }

  private fromPrisma(error: Prisma.PrismaClientKnownRequestError): ProblemDetails {
    const target = (error.meta?.target as string[] | string | undefined) ?? [];
    const fields = Array.isArray(target) ? target.join(', ') : target;

    switch (error.code) {
      case 'P2002':
        return {
          type: `${TYPE_BASE}/already-exists`,
          title: 'Already exists',
          status: HttpStatus.CONFLICT,
          detail: fields
            ? `A record with this ${fields} already exists.`
            : 'A record with these details already exists.',
        };
      case 'P2003':
        return {
          type: `${TYPE_BASE}/invalid-reference`,
          title: 'Invalid reference',
          status: HttpStatus.CONFLICT,
          detail: 'This refers to a record that does not exist.',
        };
      case 'P2025':
        return {
          type: `${TYPE_BASE}/not-found`,
          title: 'Not found',
          status: HttpStatus.NOT_FOUND,
          detail: 'The record this request refers to could not be found.',
        };
      default:
        return {
          type: `${TYPE_BASE}/database-error`,
          title: 'Something went wrong',
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          detail: 'The database rejected this request.',
        };
    }
  }
}
