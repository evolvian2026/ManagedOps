import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assignmentQuerySchema,
  convertOfferSchema,
  documentExpiryQuerySchema,
  createAssignmentSchema,
  endAssignmentSchema,
  setBillRateSchema,
  trainerQuerySchema,
  updateTrainerSchema,
  uploadDocumentSchema,
  uuidSchema,
  verifyDocumentSchema,
  type AssignmentQuery,
  type ConvertOfferInput,
  type CreateAssignmentInput,
  type DocumentExpiryQuery,
  type SetBillRateInput,
  type TrainerQuery,
  type UpdateTrainerInput,
  type UploadDocumentInput,
  type VerifyDocumentInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireAnyCapability,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { AssignmentsService } from './assignments.service.js';
import { DocumentsService } from './documents.service.js';
import { TrainersService } from './trainers.service.js';

@ApiTags('trainers')
@ApiBearerAuth()
@Audited('Trainer')
@Controller('api/v1/trainers')
export class TrainersController {
  constructor(
    private readonly trainers: TrainersService,
    private readonly documents: DocumentsService,
    private readonly assignments: AssignmentsService,
  ) {}

  @Get()
  @RequireCapability('trainers.read')
  @ApiOperation({ summary: 'List trainers, scoped to what the caller may see' })
  list(
    @Query(validate(trainerQuerySchema)) query: TrainerQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.trainers.list(query, user);
  }

  // Declared before ':id' so "me" is never parsed as an identifier.
  @Get('me')
  @RequireCapability('trainers.read')
  @ApiOperation({ summary: "The signed-in trainer's own profile" })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.trainers.me(user);
  }

  @Get(':id')
  @RequireCapability('trainers.read')
  @ApiOperation({ summary: 'One trainer, with assignments and document checklist' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.get(id, user);
  }

  @Patch(':id')
  @RequireCapability('trainers.manage')
  @ApiOperation({ summary: 'Update a trainer profile' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateTrainerSchema)) body: UpdateTrainerInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.trainers.update(id, body, user);
  }

  @Post(':id/resend-credentials')
  @RequireCapability('trainers.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email a fresh temporary password' })
  resend(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.resendCredentials(id, user);
  }

  /* ------------------------------------------------------------ documents */

  // Before ':id' so "documents/expiring" is never parsed as a trainer id.
  @Get('documents/expiring')
  @RequireCapability('trainers.read')
  @ApiOperation({ summary: 'Documents that have lapsed or are about to' })
  expiring(
    @Query(validate(documentExpiryQuerySchema)) query: DocumentExpiryQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documents.expiring(query, user);
  }

  @Get(':id/documents')
  @RequireCapability('trainers.read')
  @ApiOperation({ summary: 'The document checklist and how far through it they are' })
  listDocuments(
    @Param('id', validate(uuidSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documents.list(id, user);
  }

  @Post(':id/documents')
  // Two audiences, so two capabilities: a trainer uploading their own, and HR
  // uploading on their behalf when a scan arrives by email. Which of the two the
  // caller is decides *whose* documents they may touch, in the service.
  @RequireAnyCapability('trainers.upload_documents', 'trainers.verify_documents')
  @Audited('TrainerDocument')
  @ApiOperation({ summary: 'Upload or replace a document' })
  upload(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(uploadDocumentSchema)) body: UploadDocumentInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documents.upload(id, body, user);
  }

  @Post(':id/documents/:documentId/verify')
  @RequireCapability('trainers.verify_documents')
  @Audited('TrainerDocument')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify or reject a document; completing the set activates them' })
  verify(
    @Param('id', validate(uuidSchema)) id: string,
    @Param('documentId', validate(uuidSchema)) documentId: string,
    @Body(validate(verifyDocumentSchema)) body: VerifyDocumentInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documents.verify(id, documentId, body, user);
  }

  /* ---------------------------------------------------------- assignments */

  @Post(':id/assignments')
  @RequireCapability('assignments.manage')
  @Audited('Assignment')
  @ApiOperation({ summary: 'Put a trainer on a project' })
  assign(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(createAssignmentSchema)) body: CreateAssignmentInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assignments.create(id, body, user);
  }
}

@ApiTags('assignments')
@ApiBearerAuth()
@Audited('Assignment')
@Controller('api/v1/assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  @RequireCapability('assignments.read')
  @ApiOperation({ summary: 'List assignments' })
  list(
    @Query(validate(assignmentQuerySchema)) query: AssignmentQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assignments.list(query, user);
  }

  @Patch(':id/bill-rate')
  @RequireCapability('billing.manage')
  @ApiOperation({ summary: 'Set what the client pays per day for this assignment' })
  setBillRate(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(setBillRateSchema)) body: SetBillRateInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assignments.setBillRate(id, body, user);
  }

  @Post(':id/end')
  @RequireCapability('assignments.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End an assignment' })
  end(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(endAssignmentSchema)) body: { endDate: string; reason?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assignments.end(id, body.endDate, user);
  }
}

@ApiTags('offers')
@ApiBearerAuth()
@Audited('Trainer')
@Controller('api/v1/offers')
export class OfferConversionController {
  constructor(private readonly trainers: TrainersService) {}

  @Post(':id/convert-to-trainer')
  @RequireCapability('trainers.manage')
  @ApiOperation({ summary: 'Turn an accepted offer into a trainer with a login' })
  convert(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(convertOfferSchema)) body: ConvertOfferInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.trainers.convertOffer(id, body, user);
  }
}
