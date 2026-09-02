import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireCapability } from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { AuditService, auditQuerySchema, type AuditQuery } from './audit.service.js';

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

  @Get('export.csv')
  @RequireCapability('audit.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="managedops-audit.csv"')
  @ApiOperation({ summary: 'Export the filtered audit trail as CSV' })
  async export(@Query(validate(auditQuerySchema)) query: AuditQuery): Promise<string> {
    const result = await this.audit.list({ ...query, pageSize: 100 });
    const rows = result.data as {
      createdAt: Date;
      action: string;
      entityType: string;
      entityId: string | null;
      actor: { name: string; email: string } | null;
    }[];

    const header = 'timestamp,actor,actor_email,action,entity_type,entity_id';
    const body = rows.map((row) =>
      [
        row.createdAt.toISOString(),
        row.actor?.name ?? 'system',
        row.actor?.email ?? '',
        row.action,
        row.entityType,
        row.entityId ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
    return [header, ...body].join('\n');
  }
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
