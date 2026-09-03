import { Injectable } from '@nestjs/common';
import { eachDate, isWorkingDay } from '@managedops/shared';
import { PrismaService } from './prisma/prisma.service.js';

/**
 * How many working days a period holds, for a given project.
 *
 * Shared rather than computed where it is needed, because two things divide by
 * it — a margin prorates a salary over it, and the payroll register prorates
 * the same salary over the same month — and two copies of this that disagreed
 * would put two different numbers against one person's pay.
 *
 * Derived from the project's own calendar rather than counted off attendance:
 * a project with nobody assigned still has a month of working days, and using
 * the records would make the denominator depend on how much attendance
 * happened to be written.
 */
@Injectable()
export class WorkingDaysService {
  constructor(private readonly prisma: PrismaService) {}

  async forProjects(
    projectIds: readonly string[],
    from: string,
    to: string,
  ): Promise<Map<string, number>> {
    const ids = [...new Set(projectIds)];
    if (ids.length === 0) return new Map();

    const [projects, holidays] = await Promise.all([
      this.prisma.db.project.findMany({
        where: { id: { in: ids } },
        select: { id: true, weeklyOffDays: true },
      }),
      this.prisma.db.holiday.findMany({
        where: {
          date: {
            gte: new Date(`${from}T00:00:00.000Z`),
            lte: new Date(`${to}T00:00:00.000Z`),
          },
          // A holiday with no project is organisation-wide.
          OR: [{ projectId: null }, { projectId: { in: ids } }],
        },
        select: { projectId: true, date: true },
      }),
    ]);

    const days = [...eachDate(from, to)];
    const result = new Map<string, number>();

    for (const project of projects) {
      const applicable = holidays
        .filter((holiday) => holiday.projectId === null || holiday.projectId === project.id)
        .map((holiday) => holiday.date.toISOString().slice(0, 10));

      result.set(
        project.id,
        days.filter((day) =>
          isWorkingDay(day, { weeklyOffDays: project.weeklyOffDays, holidays: applicable }),
        ).length,
      );
    }

    return result;
  }
}
