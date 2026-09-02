import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ApplicationsService } from './applications.service.js';
import { CandidatesService } from './candidates.service.js';
import { InterviewsService } from './interviews.service.js';
import { OffersService } from './offers.service.js';
import { ApplicationsController, CandidatesController } from './recruitment.controller.js';
import { InterviewsController } from './interviews.controller.js';
import { OffersController } from './offers.controller.js';

@Module({
  // Accepting an offer consumes a seat on the position, which ProjectsModule owns.
  imports: [ProjectsModule],
  controllers: [
    CandidatesController,
    ApplicationsController,
    InterviewsController,
    OffersController,
  ],
  providers: [CandidatesService, ApplicationsService, InterviewsService, OffersService],
  exports: [ApplicationsService, InterviewsService, OffersService],
})
export class RecruitmentModule {}
