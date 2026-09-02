import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodTypeAny } from 'zod';
import { BadRequestProblem, ValidationProblem } from '../errors.js';

function toFieldErrors(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Validates one argument against a Zod schema.
 *
 * Query schemas are `.strict()` at the call site, so an unrecognised parameter
 * is rejected — but the response names the parameter and lists what is accepted.
 * Strict validation that will not say what it rejected is untriageable, and that
 * is what this deliberately avoids.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const fieldErrors = toFieldErrors(result.error);
    const unrecognised = result.error.issues.filter((issue) => issue.code === 'unrecognized_keys');

    if (unrecognised.length > 0) {
      const keys = unrecognised.flatMap((issue) =>
        'keys' in issue ? (issue.keys as string[]) : [],
      );
      const accepted = acceptedKeys(this.schema);
      throw new BadRequestProblem(
        `Unrecognised ${metadata.type === 'query' ? 'query parameter' : 'field'}: ` +
          `${keys.map((key) => `"${key}"`).join(', ')}.` +
          (accepted.length ? ` Accepted: ${accepted.join(', ')}.` : ''),
        keys.map((key) => ({ path: key, message: 'not a recognised parameter' })),
      );
    }

    const first = fieldErrors[0];
    throw new ValidationProblem(
      first ? `${first.path}: ${first.message}` : 'The request did not validate.',
      fieldErrors,
    );
  }
}

function acceptedKeys(schema: ZodTypeAny): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

export const validate = (schema: ZodTypeAny) => new ZodValidationPipe(schema);
