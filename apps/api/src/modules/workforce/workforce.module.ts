import { Module, forwardRef } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { AssignmentsService } from './assignments.service.js';
import { DocumentsService } from './documents.service.js';
import { TrainersService } from './trainers.service.js';
import {
  AssignmentsController,
  OfferConversionController,
  TrainersController,
} from './workforce.controller.js';

@Module({
  // Conversion issues a login, so it needs the password service identity owns.
  imports: [IdentityModule, forwardRef(() => ProjectsModule)],
  controllers: [TrainersController, AssignmentsController, OfferConversionController],
  providers: [TrainersService, DocumentsService, AssignmentsService],
  exports: [TrainersService, DocumentsService, AssignmentsService],
})
export class WorkforceModule {}
