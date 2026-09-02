import { HttpException, HttpStatus } from '@nestjs/common';
import type { ProblemDetails } from '@managedops/shared';

const TYPE_BASE = 'https://managedops.app/errors';

/**
 * Every failure the API returns is a Problem Details document (RFC 9457) with a
 * stable `type` a client can branch on. A domain rule violation always says
 * which rule and why — "Validation failed" with no detail is exactly the
 * unhelpful response this replaces.
 */
export class ProblemException extends HttpException {
  constructor(
    readonly problemType: string,
    title: string,
    status: HttpStatus,
    detail: string,
    readonly fieldErrors?: { path: string; message: string }[],
  ) {
    const body: ProblemDetails = {
      type: `${TYPE_BASE}/${problemType}`,
      title,
      status,
      detail,
      ...(fieldErrors?.length ? { errors: fieldErrors } : {}),
    };
    super(body, status);
  }
}

/** 422 — the request was well-formed but its contents did not validate. */
export class ValidationProblem extends ProblemException {
  constructor(detail: string, fieldErrors?: { path: string; message: string }[]) {
    super(
      'validation-failed',
      'Validation failed',
      HttpStatus.UNPROCESSABLE_ENTITY,
      detail,
      fieldErrors,
    );
  }
}

/** 400 — the request itself is malformed, e.g. an unrecognised query parameter. */
export class BadRequestProblem extends ProblemException {
  constructor(detail: string, fieldErrors?: { path: string; message: string }[]) {
    super('bad-request', 'Bad request', HttpStatus.BAD_REQUEST, detail, fieldErrors);
  }
}

/** 409 — a business rule refuses this, including every illegal state transition. */
export class DomainRuleProblem extends ProblemException {
  constructor(problemType: string, detail: string) {
    super(problemType, 'Request conflicts with a business rule', HttpStatus.CONFLICT, detail);
  }
}

export class NotFoundProblem extends ProblemException {
  constructor(what: string) {
    super('not-found', 'Not found', HttpStatus.NOT_FOUND, `${what} could not be found.`);
  }
}

export class UnauthorizedProblem extends ProblemException {
  constructor(detail = 'Sign in to continue.') {
    super('unauthorized', 'Not authenticated', HttpStatus.UNAUTHORIZED, detail);
  }
}

export class ForbiddenProblem extends ProblemException {
  constructor(detail = 'Your role does not allow this action.') {
    super('forbidden', 'Not permitted', HttpStatus.FORBIDDEN, detail);
  }
}

export class RateLimitProblem extends ProblemException {
  constructor(detail: string) {
    super('too-many-requests', 'Too many requests', HttpStatus.TOO_MANY_REQUESTS, detail);
  }
}
