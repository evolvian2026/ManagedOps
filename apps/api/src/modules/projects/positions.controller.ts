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
  createPositionSchema,
  positionQuerySchema,
  updatePositionSchema,
  uuidSchema,
  type CreatePositionInput,
  type PositionQuery,
  type UpdatePositionInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { PositionsService } from './positions.service.js';

@ApiTags('positions')
@ApiBearerAuth()
@Audited('Position')
@Controller('api/v1/positions')
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Get()
  @RequireCapability('positions.read')
  @ApiOperation({ summary: 'Open positions with their applicant counts by stage' })
  list(
    @Query(validate(positionQuerySchema)) query: PositionQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.positions.list(query, user);
  }

  @Get(':id')
  @RequireCapability('positions.read')
  @ApiOperation({ summary: 'One position' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.positions.get(id, user);
  }

  @Post()
  @RequireCapability('positions.manage')
  @ApiOperation({ summary: 'Open a position on a project' })
  create(
    @Body(validate(createPositionSchema)) body: CreatePositionInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.positions.create(body, user);
  }

  @Patch(':id')
  @RequireCapability('positions.manage')
  @ApiOperation({ summary: 'Update a position' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updatePositionSchema)) body: UpdatePositionInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.positions.update(id, body, user);
  }

  @Post(':id/close')
  @RequireCapability('positions.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop new applications; anyone already in the pipeline stays' })
  close(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.positions.close(id, user);
  }
}
