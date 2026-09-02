import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [AuthController, UsersController],
  providers: [AuthService, PasswordService, TokenService, UsersService],
  exports: [PasswordService, TokenService, UsersService],
})
export class IdentityModule {}
