import { Module } from '@nestjs/common';
import {
  MatchingController,
  PositionSkillsController,
  SkillsController,
  TrainerSkillsController,
} from './skills.controller.js';
import { SkillsService } from './skills.service.js';
import { MatchingService } from './matching.service.js';

/**
 * What people can do, what work needs, and who to put on it.
 *
 * The catalogue and the matching live together because matching is the only
 * reason the catalogue is canonical rather than free text.
 */
@Module({
  controllers: [
    SkillsController,
    TrainerSkillsController,
    PositionSkillsController,
    MatchingController,
  ],
  providers: [SkillsService, MatchingService],
  exports: [SkillsService, MatchingService],
})
export class SkillsModule {}
