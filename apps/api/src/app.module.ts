import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { loadConfiguration } from './config/configuration.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { RequestIdMiddleware } from './common/request-id.middleware.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { CapabilityGuard } from './common/guards/capability.guard.js';
import { ENTRY_POINT_KEY } from './common/decorators/index.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { AuditInterceptor } from './common/interceptors/audit.interceptor.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { FilesModule } from './modules/files/files.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { CommercialModule } from './modules/commercial/commercial.module.js';
import { SkillsModule } from './modules/skills/skills.module.js';
import { PayrollModule } from './modules/payroll/payroll.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { RecruitmentModule } from './modules/recruitment/recruitment.module.js';
import { WorkforceModule } from './modules/workforce/workforce.module.js';
import { OperationsModule } from './modules/operations/operations.module.js';
import { ExitModule } from './modules/exit/exit.module.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration], cache: true }),
    // Global because JwtAuthGuard runs on every route from the root injector.
    JwtModule.register({ global: true }),
    /**
     * Two limits, both per client address. `wide` is a flood ceiling; `entry`
     * guards the handful of routes that cost an Argon2 hash to refuse.
     *
     * In memory, which is per instance: two API containers each allow the
     * configured rate, so the effective ceiling is the limit times the number
     * of instances. That is the right trade for this shape of deployment —
     * a shared store would put a round trip in front of every request to
     * tighten a bound that is already an order of magnitude above real use —
     * and the numbers are set with it in mind.
     */
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'wide',
            ttl: config.getOrThrow<number>('rateLimit.windowSeconds') * 1000,
            limit: config.getOrThrow<number>('rateLimit.max'),
          },
          {
            name: 'entry',
            ttl: config.getOrThrow<number>('rateLimit.authWindowSeconds') * 1000,
            limit: config.getOrThrow<number>('rateLimit.authMax'),
            // Applies only where `@EntryPoint()` says it does. Inverted this
            // way round — opt in rather than skip everywhere else — because a
            // route that forgets to opt in is merely held to the wide limit,
            // whereas one that forgets to skip would throttle ordinary work.
            skipIf: (context) => !Reflect.getMetadata(ENTRY_POINT_KEY, context.getHandler()),
          },
        ],
      }),
    }),
    PrismaModule,
    AuditModule,
    NotificationsModule,
    FilesModule,
    IdentityModule,
    CommercialModule,
    SkillsModule,
    PayrollModule,
    ReviewsModule,
    ProjectsModule,
    RecruitmentModule,
    WorkforceModule,
    OperationsModule,
    ExitModule,
    JobsModule,
    HealthModule,
  ],
  providers: [
    // Order matters: count the request, authenticate, then check the
    // capability, then audit the mutation. Registering these globally is what
    // makes "every route is limited, guarded and audited" true by default
    // rather than by each controller remembering to opt in.
    //
    // The limiter goes first deliberately: a request that is over the line
    // should be refused before it costs anything, and sign-in — the one that
    // costs the most — is public, so an authenticate-first order would let it
    // through uncounted.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every request gets a trace id, including in tests where the HTTP logger
    // is not mounted — error responses carry it, so it cannot be optional.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
