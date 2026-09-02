import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { OPERATIONAL_TZ, SCHEDULED_JOBS, createBoss, safely } from './jobs/scheduler.js';
import { FilesService } from './modules/files/files.service.js';

/**
 * The scheduled-work process.
 *
 * It boots the same application context as the API — the same modules, the same
 * services, the same configuration — and runs from the same container image with
 * a different entrypoint, so the two can never drift apart in behaviour.
 *
 * Phase 0 wires the runner, the schedule and the orphaned-upload sweep. The
 * remaining handlers arrive with the modules that own them: interview reminders
 * in phase 1, document reminders in phase 2, attendance and leave in phase 3.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  const files = app.get(FilesService);

  const boss = await createBoss(config.getOrThrow<string>('databaseUrl'));
  boss.on('error', (error) => logger.error({ err: error }, 'Job queue error'));

  const handlers: Record<string, () => Promise<void>> = {
    'files.cleanup.orphans': async () => {
      // Anything unattached after a day was abandoned mid-upload.
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const orphans = await files.findOrphans(cutoff);
      const removed = await files.markDeleted(orphans.map((file) => file.id));
      if (removed > 0) logger.log({ removed }, 'Swept orphaned uploads');
    },
  };

  for (const job of SCHEDULED_JOBS) {
    const handler = handlers[job.name];
    await boss.createQueue(job.name);

    if (!handler) {
      // Registered but not yet implemented. Saying so at boot beats a job that
      // silently does nothing for a phase and a half.
      logger.warn({ job: job.name }, `Scheduled but not yet implemented: ${job.description}`);
      continue;
    }

    await boss.work(job.name, safely(job.name, logger, handler));
    await boss.schedule(job.name, job.cron, undefined, { tz: OPERATIONAL_TZ });
    logger.log({ job: job.name, cron: job.cron }, job.description);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.log({ signal }, 'Shutting down worker');
    await boss.stop({ graceful: true });
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.log(`Worker ready — ${SCHEDULED_JOBS.length} jobs registered, times in ${OPERATIONAL_TZ}`);
}

bootstrap().catch((error: unknown) => {
  console.error('ManagedOps worker failed to start:', error);
  process.exit(1);
});
