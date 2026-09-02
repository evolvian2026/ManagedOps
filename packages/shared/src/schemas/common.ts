import { z } from 'zod';

/** `YYYY-MM-DD`, the shape every work date crosses the wire in. */
export const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Not a real calendar date');

export const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time as HH:MM');

export const uuidSchema = z.string().uuid('Expected an identifier');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254);

/** Indian mobile numbers, optionally with a +91 country code. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^(\+91[- ]?)?[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number');

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** `field` ascending, `-field` descending. */
  sort: z
    .string()
    .regex(/^-?[a-zA-Z][a-zA-Z0-9_.]*$/, 'Sort must be a field name, optionally prefixed with -')
    .optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

/** RFC 9457 Problem Details — the single error shape the API returns. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  traceId?: string;
  errors?: { path: string; message: string }[];
}
