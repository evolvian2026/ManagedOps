import { Injectable } from '@nestjs/common';
import type {
  CreateSkillInput,
  SetPositionSkillInput,
  SetTrainerSkillInput,
  SkillQuery,
  UpdateSkillInput,
} from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { paginate, toPrismaPage } from '../../common/pagination.js';
import { DomainRuleProblem, NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { positionScope, scopedWhere, trainerScope } from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

const SORTABLE = ['name', 'category', 'createdAt'] as const;

const SKILL_SELECT = {
  id: true,
  name: true,
  category: true,
  status: true,
  createdAt: true,
} as const;

const TRAINER_SKILL_SELECT = {
  id: true,
  proficiency: true,
  years: true,
  lastUsedOn: true,
  notes: true,
  skill: { select: SKILL_SELECT },
} as const;

@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------------------------------------ catalogue */

  async list(query: SkillQuery) {
    const where = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
    };

    const page = toPrismaPage(query, SORTABLE, { name: 'asc' });
    const [rows, total] = await Promise.all([
      this.prisma.db.skill.findMany({
        where,
        ...page,
        select: { ...SKILL_SELECT, _count: { select: { trainers: true } } },
      }),
      this.prisma.db.skill.count({ where }),
    ]);

    return paginate(rows, total, query);
  }

  async create(input: CreateSkillInput, actor: AuthenticatedUser) {
    await this.assertNameIsFree(input.name);
    return this.prisma.db.skill.create({
      data: {
        id: newId(),
        name: input.name,
        category: input.category,
        createdById: actor.userId,
      },
      select: SKILL_SELECT,
    });
  }

  async update(id: string, input: UpdateSkillInput, actor: AuthenticatedUser) {
    const skill = await this.prisma.db.skill.findFirst({ where: { id, deletedAt: null } });
    if (!skill) throw new NotFoundProblem('That skill');

    if (input.name !== undefined && input.name !== skill.name) {
      await this.assertNameIsFree(input.name);
    }

    return this.prisma.db.skill.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedById: actor.userId,
      },
      select: SKILL_SELECT,
    });
  }

  /**
   * Retires a skill without erasing it.
   *
   * A skill somebody claims is not deletable, because deleting it would rewrite
   * their profile and every past match that turned on it. Archiving keeps both
   * and only removes it from the pickers.
   */
  async remove(id: string, actor: AuthenticatedUser) {
    const skill = await this.prisma.db.skill.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { trainers: true, positions: true } } },
    });
    if (!skill) throw new NotFoundProblem('That skill');

    const inUse = skill._count.trainers + skill._count.positions;
    if (inUse > 0) {
      throw new DomainRuleProblem(
        'skill-in-use',
        `${skill.name} is on ${skill._count.trainers} profile${skill._count.trainers === 1 ? '' : 's'} and ${skill._count.positions} position${skill._count.positions === 1 ? '' : 's'}. Archive it instead, which keeps the history and takes it out of the pickers.`,
      );
    }

    await this.prisma.db.skill.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: actor.userId },
    });
    return { id, deleted: true };
  }

  /* ------------------------------------------------------ trainer profiles */

  async forTrainer(trainerId: string, user: AuthenticatedUser) {
    await this.assertTrainerVisible(trainerId, user, 'skills.read');

    return this.prisma.db.trainerSkill.findMany({
      where: { trainerId },
      select: TRAINER_SKILL_SELECT,
      orderBy: [{ proficiency: 'desc' }, { skill: { name: 'asc' } }],
    });
  }

  /**
   * Adds a skill to a profile, or updates it if it is already there.
   *
   * An upsert rather than separate add and edit calls: "I know React" is one
   * fact, and making the client discover which verb applies would only invite
   * a duplicate the unique index would then reject.
   */
  async setForTrainer(trainerId: string, input: SetTrainerSkillInput, actor: AuthenticatedUser) {
    await this.assertTrainerVisible(trainerId, actor, 'skills.manage');

    const skill = await this.prisma.db.skill.findFirst({
      where: { id: input.skillId, deletedAt: null },
      select: { id: true, name: true, status: true },
    });
    if (!skill) throw new NotFoundProblem('That skill');
    if (skill.status === 'archived') {
      throw new DomainRuleProblem(
        'skill-archived',
        `${skill.name} has been archived, so it cannot be added to a profile.`,
      );
    }

    return this.prisma.db.trainerSkill.upsert({
      where: { trainerId_skillId: { trainerId, skillId: input.skillId } },
      create: {
        id: newId(),
        trainerId,
        skillId: input.skillId,
        proficiency: input.proficiency,
        years: input.years,
        lastUsedOn: input.lastUsedOn ? new Date(`${input.lastUsedOn}T00:00:00.000Z`) : null,
        notes: input.notes,
        createdById: actor.userId,
      },
      update: {
        proficiency: input.proficiency,
        years: input.years ?? null,
        lastUsedOn: input.lastUsedOn ? new Date(`${input.lastUsedOn}T00:00:00.000Z`) : null,
        notes: input.notes ?? null,
        updatedById: actor.userId,
      },
      select: TRAINER_SKILL_SELECT,
    });
  }

  async removeFromTrainer(trainerId: string, skillId: string, actor: AuthenticatedUser) {
    await this.assertTrainerVisible(trainerId, actor, 'skills.manage');

    const existing = await this.prisma.db.trainerSkill.findUnique({
      where: { trainerId_skillId: { trainerId, skillId } },
      select: { id: true },
    });
    if (!existing) throw new NotFoundProblem('That skill on this profile');

    await this.prisma.db.trainerSkill.delete({ where: { id: existing.id } });
    return { skillId, removed: true };
  }

  /* ----------------------------------------------------- position profiles */

  async forPosition(positionId: string, user: AuthenticatedUser) {
    await this.assertPositionVisible(positionId, user);

    return this.prisma.db.positionSkill.findMany({
      where: { positionId },
      select: {
        id: true,
        requirement: true,
        minProficiency: true,
        skill: { select: SKILL_SELECT },
      },
      orderBy: [{ requirement: 'asc' }, { skill: { name: 'asc' } }],
    });
  }

  async setForPosition(positionId: string, input: SetPositionSkillInput, actor: AuthenticatedUser) {
    await this.assertPositionVisible(positionId, actor);

    const skill = await this.prisma.db.skill.findFirst({
      where: { id: input.skillId, deletedAt: null, status: 'active' },
      select: { id: true },
    });
    if (!skill) throw new NotFoundProblem('That skill');

    return this.prisma.db.positionSkill.upsert({
      where: { positionId_skillId: { positionId, skillId: input.skillId } },
      create: {
        id: newId(),
        positionId,
        skillId: input.skillId,
        requirement: input.requirement,
        minProficiency: input.minProficiency,
        createdById: actor.userId,
      },
      update: {
        requirement: input.requirement,
        minProficiency: input.minProficiency ?? null,
      },
      select: {
        id: true,
        requirement: true,
        minProficiency: true,
        skill: { select: SKILL_SELECT },
      },
    });
  }

  async removeFromPosition(positionId: string, skillId: string, actor: AuthenticatedUser) {
    await this.assertPositionVisible(positionId, actor);

    const existing = await this.prisma.db.positionSkill.findUnique({
      where: { positionId_skillId: { positionId, skillId } },
      select: { id: true },
    });
    if (!existing) throw new NotFoundProblem('That requirement on this position');

    await this.prisma.db.positionSkill.delete({ where: { id: existing.id } });
    return { skillId, removed: true };
  }

  /* ----------------------------------------------------------------- guards */

  /**
   * A skill list is only ever reached through the trainer who owns it, so the
   * trainer's own scope decides it. A trainer reaches their own record and no
   * other; a lead reaches their project's team. Applying the scope here means
   * every route below inherits it rather than restating it.
   */
  private async assertTrainerVisible(
    trainerId: string,
    user: AuthenticatedUser,
    capability: 'skills.read' | 'skills.manage',
  ) {
    const trainer = await this.prisma.db.trainer.findFirst({
      where: scopedWhere(trainerScope(user, capability), { id: trainerId }),
      select: { id: true },
    });
    if (!trainer) throw new NotFoundProblem('That trainer');
  }

  private async assertPositionVisible(positionId: string, user: AuthenticatedUser) {
    const position = await this.prisma.db.position.findFirst({
      where: scopedWhere(positionScope(user), { id: positionId, deletedAt: null }),
      select: { id: true },
    });
    if (!position) throw new NotFoundProblem('That position');
  }

  private async assertNameIsFree(name: string) {
    // A skill archived or soft-deleted still holds the unique index, so only
    // checking live rows would promise a name the database then refuses.
    const existing = await this.prisma.raw.skill.findUnique({ where: { name } });
    if (existing) {
      throw new ValidationProblem(`A skill called ${name} already exists.`, [
        { path: 'name', message: 'already in the catalogue' },
      ]);
    }
  }
}
