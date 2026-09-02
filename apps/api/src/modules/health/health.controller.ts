import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/index.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { FilesService } from '../files/files.service.js';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  /** Liveness: the process is up. Deliberately does no I/O. */
  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Liveness probe' })
  health() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness: the dependencies this process needs are actually reachable. */
  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Readiness probe — checks the database and object storage' })
  async ready(@Res({ passthrough: true }) response: Response) {
    const [database, storage] = await Promise.all([
      this.prisma.isHealthy(),
      this.files.isReachable(),
    ]);
    const ready = database && storage;
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ready' : 'degraded', checks: { database, storage } };
  }
}
