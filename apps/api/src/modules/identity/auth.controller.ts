import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaChallengeSchema,
  mfaDisableSchema,
  mfaVerifySchema,
  resetPasswordSchema,
  type ChangePasswordInput,
  type LoginInput,
  type MfaChallengeInput,
  type MfaDisableInput,
  type MfaVerifyInput,
} from '@managedops/shared';
import {
  AllowDuringPasswordChange,
  CurrentUser,
  Public,
  SkipAudit,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';

import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { ForbiddenProblem, UnauthorizedProblem } from '../../common/errors.js';
import { AuthService, isMfaChallenge, type SessionResult } from './auth.service.js';
import { MfaService } from './mfa.service.js';
import { TokenService } from './token.service.js';

const REFRESH_COOKIE = 'managedops_refresh';
const CSRF_COOKIE = 'managedops_csrf';
const CSRF_HEADER = 'x-csrf-token';
const COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
// AuthService writes its own entries with the resolved actor and outcome.
@SkipAudit()
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in; returns an access token and sets the refresh cookie' })
  async login(
    @Body(validate(loginSchema)) body: LoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(body, requestMeta(request));
    // A challenge is not a session, so no cookie is set here. Anything that
    // treats the two alike is the bug this shape exists to prevent.
    if (isMfaChallenge(result)) return result;
    return this.completeSession(result, response);
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish a sign-in with a code from an authenticator' })
  async verifyMfa(
    @Body(validate(mfaVerifySchema)) body: MfaVerifyInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.verifyMfa(body.challengeToken, body.code, requestMeta(request));
    return this.completeSession(session, response);
  }

  /**
   * Setting up a second factor, from either side of the line.
   *
   * With a challenge token: somebody whose role requires one and has not got
   * one, part-way through a sign-in. Without: somebody already signed in who is
   * adding one voluntarily. Same secret, same proof, two ways in.
   */
  /**
   * Setting up an authenticator part-way through a sign-in.
   *
   * Separate from the signed-in route below rather than one endpoint taking an
   * optional token: this one is reachable without a session by design, and a
   * route that is public *sometimes* is a route whose audience nobody can state.
   */
  @Post('login/mfa/enrol')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin setting up an authenticator during sign-in' })
  enrolDuringLogin(@Body(validate(mfaChallengeSchema)) body: MfaChallengeInput) {
    return this.auth.enrolFromChallenge(body.challengeToken);
  }

  @Post('login/mfa/activate')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn the authenticator on and finish signing in' })
  async activateDuringLogin(
    @Body(validate(mfaVerifySchema)) body: MfaVerifyInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { recoveryCodes, ...session } = await this.auth.activateFromChallenge(
      body.challengeToken,
      body.code,
      requestMeta(request),
    );
    return { ...this.completeSession(session, response), recoveryCodes };
  }

  @Post('mfa/enrol')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin adding an authenticator to your account' })
  enrolMfa(@CurrentUser('userId') userId: string) {
    return this.mfa.beginEnrolment(userId);
  }

  @Post('mfa/activate')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Prove the authenticator works and turn it on' })
  activateMfa(
    @CurrentUser('userId') userId: string,
    @Body(validate(mfaDisableSchema)) body: MfaDisableInput,
  ) {
    return this.mfa.completeEnrolment(userId, body.code);
  }

  @Delete('mfa')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove your authenticator, where your role allows it' })
  async disableMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body(validate(mfaDisableSchema)) body: MfaDisableInput,
  ) {
    await this.mfa.disable(user.userId, user.role, body.code);
    return { message: 'Your authenticator has been removed.' };
  }

  @Get('mfa')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Whether you hold a second factor, and whether you must' })
  mfaStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.statusFor(user.userId, user.role);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh cookie and issue a new access token' })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const presented = readCookie(request, REFRESH_COOKIE);
    if (!presented) throw new UnauthorizedProblem('Sign in to continue.');
    this.assertCsrf(request);

    const session = await this.auth.refresh(presented, requestMeta(request));
    return this.completeSession(session, response);
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current refresh token and clear the cookies' })
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(readCookie(request, REFRESH_COOKIE));
    this.clearCookies(response);
  }

  @Get('me')
  @ApiBearerAuth()
  @AllowDuringPasswordChange()
  @ApiOperation({ summary: 'The signed-in user, their role and their capabilities' })
  me(@CurrentUser('userId') userId: string) {
    return this.auth.me(userId);
  }

  @Post('change-password')
  @ApiBearerAuth()
  @AllowDuringPasswordChange()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change your password; signs out every other session' })
  async changePassword(
    @CurrentUser('userId') userId: string,
    @Body(validate(changePasswordSchema)) body: ChangePasswordInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.changePassword(userId, body, requestMeta(request));
    return this.completeSession(session, response);
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a reset link if the address has an account' })
  async forgotPassword(@Body(validate(forgotPasswordSchema)) body: { email: string }) {
    await this.auth.requestPasswordReset(body.email);
    // Deliberately identical whether or not the address exists.
    return { message: 'If that address has an account, a reset link is on its way.' };
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password using a reset link' })
  async resetPassword(
    @Body(validate(resetPasswordSchema)) body: { token: string; newPassword: string },
  ) {
    await this.auth.resetPassword(body.token, body.newPassword);
    return { message: 'Your password has been changed. Sign in with it now.' };
  }

  /**
   * The refresh token goes into an httpOnly cookie so no script can read it,
   * while the access token is returned in the body for the client to keep in
   * memory only. The CSRF cookie is deliberately readable — the client echoes it
   * back in a header, and only same-origin script can do that.
   */
  private completeSession(session: SessionResult, response: Response) {
    const secure = this.config.getOrThrow<boolean>('cookieSecure');
    const csrfToken = randomBytes(24).toString('hex');

    response.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: this.tokens.refreshTtlMs(),
    });
    response.cookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: this.tokens.refreshTtlMs(),
    });

    const { refreshToken: _discarded, ...body } = session;
    return body;
  }

  private clearCookies(response: Response): void {
    response.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    response.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  /** Double-submit check: the header must match the cookie the client holds. */
  private assertCsrf(request: Request): void {
    const cookie = readCookie(request, CSRF_COOKIE);
    const header = request.headers[CSRF_HEADER];
    if (!cookie || typeof header !== 'string' || header !== cookie) {
      throw new ForbiddenProblem('This request could not be verified. Reload the page and retry.');
    }
  }
}

function readCookie(request: Request, name: string): string | undefined {
  const jar = (request as Request & { cookies?: Record<string, string> }).cookies;
  return jar?.[name];
}

function requestMeta(request: Request) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}
