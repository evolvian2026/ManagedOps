import { Module } from '@nestjs/common';
import { RecruitmentModule } from '../modules/recruitment/recruitment.module.js';
import { WorkforceModule } from '../modules/workforce/workforce.module.js';
import { OperationsModule } from '../modules/operations/operations.module.js';
import { InterviewJobs } from './interview-jobs.js';
import { OnboardingJobs } from './onboarding-jobs.js';
import { OperationsJobs } from './operations-jobs.js';

/**
 * Job handlers, kept in their own module so the worker process can resolve them
 * from the same application context the API uses — same services, same rules.
 */
@Module({
  imports: [RecruitmentModule, WorkforceModule, OperationsModule],
  providers: [InterviewJobs, OnboardingJobs, OperationsJobs],
  exports: [InterviewJobs, OnboardingJobs, OperationsJobs],
})
export class JobsModule {}
