import { Module, forwardRef } from '@nestjs/common';
import { PositionsController } from './positions.controller.js';
import { PositionsService } from './positions.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { WorkforceModule } from '../workforce/workforce.module.js';

@Module({
  // The roster is a projects screen backed by workforce data; forwardRef because
  // assigning a trainer needs the project scope in the other direction.
  imports: [forwardRef(() => WorkforceModule)],
  controllers: [ProjectsController, PositionsController],
  providers: [ProjectsService, PositionsService],
  exports: [ProjectsService, PositionsService],
})
export class ProjectsModule {}
