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
import { uuidSchema } from '@managedops/shared';
import { Audited, CurrentUser, RequireCapability } from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import {
  UsersService,
  createUserSchema,
  updateUserSchema,
  userQuerySchema,
  type CreateUserInput,
  type UpdateUserInput,
  type UserQuery,
} from './users.service.js';

@ApiTags('users')
@ApiBearerAuth()
@Audited('User')
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequireCapability('users.manage')
  @ApiOperation({ summary: 'List administrative accounts' })
  list(@Query(validate(userQuerySchema)) query: UserQuery) {
    return this.users.list(query);
  }

  @Get(':id')
  @RequireCapability('users.manage')
  @ApiOperation({ summary: 'Fetch one account' })
  get(@Param('id', validate(uuidSchema)) id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequireCapability('users.manage')
  @ApiOperation({ summary: 'Create an account and email it a temporary password' })
  create(
    @Body(validate(createUserSchema)) body: CreateUserInput,
    @CurrentUser('userId') actorId: string,
  ) {
    return this.users.create(body, actorId);
  }

  @Patch(':id')
  @RequireCapability('users.manage')
  @ApiOperation({ summary: 'Update an account name, phone or role' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateUserSchema)) body: UpdateUserInput,
    @CurrentUser('userId') actorId: string,
  ) {
    return this.users.update(id, body, actorId);
  }

  @Post(':id/disable')
  @RequireCapability('users.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable an account and sign out its sessions' })
  disable(@Param('id', validate(uuidSchema)) id: string, @CurrentUser('userId') actorId: string) {
    return this.users.disable(id, actorId);
  }

  @Post(':id/enable')
  @RequireCapability('users.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-enable a disabled account' })
  enable(@Param('id', validate(uuidSchema)) id: string, @CurrentUser('userId') actorId: string) {
    return this.users.enable(id, actorId);
  }

  @Post(':id/reset-password')
  @RequireCapability('users.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a new temporary password by email' })
  resetPassword(
    @Param('id', validate(uuidSchema)) id: string,
    @CurrentUser('userId') actorId: string,
  ) {
    return this.users.resetPassword(id, actorId);
  }

  /**
   * For somebody who has lost the phone their authenticator was on.
   *
   * Behind `users.manage` and audited, because it is the one way to turn a
   * second factor off for an account that is required to have one — and it
   * leaves them enrolling again on their next sign-in rather than without one.
   */
  @Post(':id/reset-mfa')
  @RequireCapability('users.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear somebody’s authenticator so they can set up a new one' })
  resetMfa(@Param('id', validate(uuidSchema)) id: string) {
    // Who did it is recorded by the audit interceptor; there is no column on a
    // cleared authenticator to stamp an actor into.
    return this.users.resetMfa(id);
  }
}
