import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  clientQuerySchema,
  createClientSchema,
  updateClientSchema,
  uuidSchema,
  type ClientQuery,
  type CreateClientInput,
  type UpdateClientInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { sendCsv, toCsv } from '../../common/csv.js';
import { ClientsService } from './clients.service.js';

const EXPORT_PAGE_SIZE = 100;

@ApiTags('clients')
@ApiBearerAuth()
@Audited('Client')
@Controller('api/v1/clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @RequireCapability('clients.read')
  @ApiOperation({ summary: 'List clients' })
  list(
    @Query(validate(clientQuerySchema)) query: ClientQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.clients.list(query, user);
  }

  // Before ':id' so "export.csv" is never parsed as an identifier.
  @Get('export.csv')
  @RequireCapability('clients.read')
  @ApiOperation({ summary: 'Export the filtered clients as CSV' })
  async export(
    @Query(validate(clientQuerySchema)) query: ClientQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.clients.list({ ...query, page: 1, pageSize: EXPORT_PAGE_SIZE }, user);
    const body = toCsv(result.data, [
      { header: 'code', value: (row) => row.code },
      { header: 'name', value: (row) => row.name },
      { header: 'status', value: (row) => row.status },
      { header: 'contact_name', value: (row) => row.contactName },
      { header: 'contact_email', value: (row) => row.contactEmail },
      { header: 'contact_phone', value: (row) => row.contactPhone },
      { header: 'gstin', value: (row) => row.gstin },
      { header: 'active_projects', value: (row) => row._count.projects },
      // Present only for a caller who may read it; the service decides, not this.
      {
        header: 'default_day_rate',
        value: (row) => ('defaultDayRate' in row ? row.defaultDayRate : ''),
      },
    ]);
    sendCsv(response, 'managedops-clients.csv', body);
  }

  @Get(':id')
  @RequireCapability('clients.read')
  @ApiOperation({ summary: 'One client, with the projects delivered for them' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.clients.get(id, user);
  }

  @Post()
  @RequireCapability('clients.manage')
  @ApiOperation({ summary: 'Create a client' })
  create(
    @Body(validate(createClientSchema)) body: CreateClientInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.clients.create(body, user);
  }

  @Patch(':id')
  @RequireCapability('clients.manage')
  @ApiOperation({ summary: 'Update a client' })
  update(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(updateClientSchema)) body: UpdateClientInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.clients.update(id, body, user);
  }

  @Delete(':id')
  @RequireCapability('clients.manage')
  @ApiOperation({ summary: 'Soft-delete a client nothing points at' })
  remove(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.clients.remove(id, user);
  }
}
