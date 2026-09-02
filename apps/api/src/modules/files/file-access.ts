import { Injectable } from '@nestjs/common';
import { can } from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ForbiddenProblem, NotFoundProblem } from '../../common/errors.js';
import {
  candidateScope,
  deliverableScope,
  reimbursementScope,
  scopedWhere,
  trainerScope,
} from '../../common/scope.js';
import type { AuthenticatedUser } from '../../common/decorators/index.js';

/**
 * Who may open a stored file.
 *
 * An unguessable identifier is not authorisation. Every file id in the system is
 * handed to a client somewhere — a résumé id on a candidate row, a receipt id on
 * a claim, a scan id on a document — so "you would have to know the id" only
 * holds until somebody reads a response they were legitimately given. A Project
 * Lead reading their team's document checklist is exactly that case: they may
 * see that an Aadhaar exists, and must not be able to open it.
 *
 * Authorisation therefore runs against the record the file belongs to, using the
 * same capability and scope the owning module enforces. A file attached to
 * nothing is readable only by whoever uploaded it, because until it is attached
 * there is no record to reason about.
 */
@Injectable()
export class FileAccessPolicy {
  constructor(private readonly prisma: PrismaService) {}

  async assertMayDownload(
    file: { id: string; ownerType: string | null; ownerId: string | null; uploadedById: string },
    user: AuthenticatedUser,
  ): Promise<void> {
    if (await this.mayDownload(file, user)) return;
    throw new ForbiddenProblem('You do not have access to that file.');
  }

  private async mayDownload(
    file: { id: string; ownerType: string | null; ownerId: string | null; uploadedById: string },
    user: AuthenticatedUser,
  ): Promise<boolean> {
    // Whoever put it there can always read it back — including while an upload
    // is still being attached to the record it belongs to.
    if (file.uploadedById === user.userId) return true;
    if (!file.ownerType || !file.ownerId) return false;

    switch (file.ownerType) {
      case 'TrainerDocument':
        return this.mayReadTrainerDocument(file.ownerId, user);
      case 'Trainer':
        return this.mayReadTrainerDocumentsOf(file.ownerId, user);
      case 'Candidate':
        return this.mayReadCandidate(file.ownerId, user);
      case 'Reimbursement':
        return this.mayReadClaim(file.ownerId, user);
      case 'Deliverable':
        return this.mayReadDeliverable(file.ownerId, user);
      default:
        // An owner type nothing here understands is refused rather than allowed.
        // A new attachment kind should have to say who may read it.
        return false;
    }
  }

  /**
   * Identity documents are HR's business (spec 3.3). A Manager may see that a
   * document exists and whether it is verified; opening it needs
   * `trainers.read_documents`, and a trainer may always open their own.
   */
  private async mayReadTrainerDocument(
    documentId: string,
    user: AuthenticatedUser,
  ): Promise<boolean> {
    const document = await this.prisma.db.trainerDocument.findUnique({
      where: { id: documentId },
      select: { trainerId: true },
    });
    if (!document) return false;
    return this.mayReadTrainerDocumentsOf(document.trainerId, user);
  }

  private async mayReadTrainerDocumentsOf(
    trainerId: string,
    user: AuthenticatedUser,
  ): Promise<boolean> {
    if (user.trainerId === trainerId) return true;
    if (!can(user.role, 'trainers.read_documents')) return false;

    const visible = await this.prisma.db.trainer.findFirst({
      where: scopedWhere(trainerScope(user, 'trainers.read_documents'), { id: trainerId }),
      select: { id: true },
    });
    return visible !== null;
  }

  private async mayReadCandidate(candidateId: string, user: AuthenticatedUser): Promise<boolean> {
    if (!can(user.role, 'candidates.read')) return false;
    const visible = await this.prisma.db.candidate.findFirst({
      where: scopedWhere(candidateScope(user), { id: candidateId }),
      select: { id: true },
    });
    return visible !== null;
  }

  private async mayReadClaim(claimId: string, user: AuthenticatedUser): Promise<boolean> {
    const capability = can(user.role, 'reimbursements.approve')
      ? ('reimbursements.approve' as const)
      : ('reimbursements.submit' as const);
    if (!can(user.role, capability)) return false;

    const visible = await this.prisma.db.reimbursement.findFirst({
      where: scopedWhere(reimbursementScope(user, capability), { id: claimId }),
      select: { id: true },
    });
    return visible !== null;
  }

  private async mayReadDeliverable(
    deliverableId: string,
    user: AuthenticatedUser,
  ): Promise<boolean> {
    if (!can(user.role, 'deliverables.read')) return false;
    const visible = await this.prisma.db.deliverable.findFirst({
      where: scopedWhere(deliverableScope(user), { id: deliverableId }),
      select: { id: true },
    });
    return visible !== null;
  }
}

/** Files whose owner id is not set until the record they belong to is created. */
export function isUnattached(file: { ownerType: string | null; ownerId: string | null }): boolean {
  return !file.ownerType || !file.ownerId;
}

/** Thrown by callers that look a file up before checking it exists. */
export function requireFile<T>(file: T | null): T {
  if (!file) throw new NotFoundProblem('That file');
  return file;
}
