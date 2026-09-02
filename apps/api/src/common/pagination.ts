import type { PageMeta, Paginated, PaginationQuery } from '@managedops/shared';
import { BadRequestProblem } from './errors.js';

export interface PrismaPage {
  skip: number;
  take: number;
  orderBy?: Record<string, 'asc' | 'desc'>;
}

/**
 * Turns a validated pagination query into Prisma arguments.
 *
 * `sortable` is an allow-list: a client asking to sort by a column that is not
 * listed gets a 400 naming the field and the options, rather than a 500 from
 * Prisma or a silently ignored parameter.
 */
export function toPrismaPage(
  query: PaginationQuery,
  sortable: readonly string[],
  defaultSort: Record<string, 'asc' | 'desc'> = { createdAt: 'desc' },
): PrismaPage {
  const page: PrismaPage = {
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
    orderBy: defaultSort,
  };

  if (query.sort) {
    const descending = query.sort.startsWith('-');
    const field = descending ? query.sort.slice(1) : query.sort;
    if (!sortable.includes(field)) {
      throw new BadRequestProblem(
        `Cannot sort by "${field}". Sortable fields are: ${sortable.join(', ')}.`,
        [{ path: 'sort', message: `"${field}" is not sortable` }],
      );
    }
    page.orderBy = { [field]: descending ? 'desc' : 'asc' };
  }

  return page;
}

export function paginate<T>(data: T[], total: number, query: PaginationQuery): Paginated<T> {
  const meta: PageMeta = {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
  return { data, meta };
}
