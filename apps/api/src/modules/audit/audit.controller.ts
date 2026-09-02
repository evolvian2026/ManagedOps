import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireCapability } from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { sendCsv, toCsv } from '../../common/csv.js';
import { AuditService, auditQuerySchema, type AuditQuery } from './audit.service.js';

interface AuditRow {
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  actor: { name: string; email: string } | null;
}

@ApiTags('audit')
@ApiBearerAuth()
@Controller('api/v1/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireCapability('audit.read')
  @ApiOperation({ summary: 'List audit entries, filtered by actor, entity, action or date' })
  list(@Query(validate(auditQuerySchema)) query: AuditQuery) {
    return this.audit.list(query);
  }

  /**
   * The filtered trail as CSV.
   *
   * Escaping goes through the shared helper rather than a local one: an audit
   * export carries user-supplied text — a rejection note, an entity name — and
   * a field beginning with `=` is executed as a formula by the spreadsheet that
   * opens it. The naive escape this replaced quoted commas and nothing else.
   */
  @Get('export.csv')
  @RequireCapability('audit.read')
  @ApiOperation({ summary: 'Export the filtered audit trail as CSV' })
  async export(
    @Query(validate(auditQuerySchema)) query: AuditQuery,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.audit.list({ ...query, page: 1, pageSize: 1000 });

    const body = toCsv(result.data as AuditRow[], [
      { header: 'timestamp', value: (row) => row.createdAt },
      { header: 'actor', value: (row) => row.actor?.name ?? 'system' },
      { header: 'actor_email', value: (row) => row.actor?.email ?? '' },
      { header: 'action', value: (row) => row.action },
      { header: 'entity_type', value: (row) => row.entityType },
      { header: 'entity_id', value: (row) => row.entityId },
      { header: 'ip', value: (row) => row.ip },
    ]);

    sendCsv(response, 'managedops-audit.csv', body);
  }
}
