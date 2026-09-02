import { Module } from '@nestjs/common';
import { PositionsController } from './positions.controller.js';
import { PositionsService } from './positions.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  controllers: [ProjectsController, PositionsController],
  providers: [ProjectsService, PositionsService],
  exports: [ProjectsService, PositionsService],
})
export class ProjectsModule {}
