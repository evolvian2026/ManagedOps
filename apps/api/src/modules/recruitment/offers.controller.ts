import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createOfferSchema,
  offerQuerySchema,
  respondToOfferSchema,
  reviseOfferSchema,
  sendOfferSchema,
  uuidSchema,
  type CreateOfferInput,
  type OfferQuery,
  type RespondToOfferInput,
  type ReviseOfferInput,
} from '@managedops/shared';
import {
  Audited,
  CurrentUser,
  RequireCapability,
  type AuthenticatedUser,
} from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { OffersService } from './offers.service.js';

@ApiTags('offers')
@ApiBearerAuth()
@Audited('Offer')
@Controller('api/v1/offers')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Get()
  @RequireCapability('offers.read')
  @ApiOperation({ summary: 'List offers; latestOnly gives one row per candidate' })
  list(
    @Query(validate(offerQuerySchema)) query: OfferQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.offers.list(query, user);
  }

  @Get(':id')
  @RequireCapability('offers.read')
  @ApiOperation({ summary: 'One offer, with every earlier version of it' })
  get(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.offers.get(id, user);
  }

  @Post()
  @RequireCapability('offers.manage')
  @ApiOperation({ summary: 'Draft an offer for a selected candidate' })
  create(
    @Body(validate(createOfferSchema)) body: CreateOfferInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.offers.create(body, user);
  }

  @Post(':id/send')
  @RequireCapability('offers.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the offer sent and email the candidate' })
  send(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(sendOfferSchema)) body: { attachmentFileId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.offers.send(id, body.attachmentFileId, user);
  }

  @Post(':id/respond')
  @RequireCapability('offers.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record the candidate's answer" })
  respond(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(respondToOfferSchema)) body: RespondToOfferInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.offers.respond(id, body, user);
  }

  @Post(':id/revise')
  @RequireCapability('offers.manage')
  @ApiOperation({ summary: 'Supersede this offer with a new version' })
  revise(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(reviseOfferSchema)) body: ReviseOfferInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.offers.revise(id, body, user);
  }

  @Post(':id/withdraw')
  @RequireCapability('offers.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw an offer' })
  withdraw(@Param('id', validate(uuidSchema)) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.offers.withdraw(id, user);
  }
}
