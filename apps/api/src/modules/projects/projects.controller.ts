import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createHolidaySchema,
  createProjectSchema,
  projectQuerySchema,
  updateProjectSchema,
  uuidSchema,
  type CreateProjectInput,
  type ProjectQuery,
  type UpdateProjectInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { ProjectsService } from './projects.service.js';

@ApiTags('projects')
@ApiBearerAuth()
@Audited('Project')
@Controller('api/v1/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequireCapability('projects.read')
  @ApiOperation({ summary: 'List projects, scoped to what the caller may see' })
  list(
    @Query(validate(projectQuerySchema)) query: ProjectQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projects.list(query, user);
  }

  @Get(':id')
  @RequireCapability('projects.read')
  @ApiOperation({ summary: 'One project, with its positions' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.projects.get(id, user);
  }

  @Post()
  @RequireCapability('projects.manage')
  @ApiOperation({ summary: 'Create a project' })
  create(
    @Body(validate(createProjectSchema)) body: CreateProjectInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projects.create(body, user);
  }

  @Patch(':id')
  @RequireCapability('projects.manage')
  @ApiOperation({ summary: 'Update a project' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateProjectSchema)) body: UpdateProjectInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projects.update(id, body, user);
  }

  @Delete(':id')
  @RequireCapability('projects.manage')
  @ApiOperation({ summary: 'Soft-delete a project that has never been staffed' })
  remove(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.projects.remove(id, user);
  }

  @Get(':id/holidays')
  @RequireCapability('projects.read')
  @ApiOperation({ summary: 'Holidays for this project, including organisation-wide ones' })
  holidays(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.projects.listHolidays(id, user);
  }

  @Post(':id/holidays')
  @RequireCapability('projects.manage')
  @Audited('Holiday')
  @ApiOperation({ summary: 'Add a holiday to this project' })
  addHoliday(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(createHolidaySchema)) body: { date: string; name: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projects.addHoliday(id, body, user);
  }
}
