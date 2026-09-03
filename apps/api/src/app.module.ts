import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { loadConfiguration } from './config/configuration.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { RequestIdMiddleware } from './common/request-id.middleware.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { CapabilityGuard } from './common/guards/capability.guard.js';
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
    // Order matters: authenticate, then check the capability, then audit the
    // mutation. Registering these globally is what makes "every route is
    // guarded and every mutation is audited" true by default rather than by
    // each controller remembering to opt in.
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
