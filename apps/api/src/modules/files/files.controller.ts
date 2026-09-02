import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { uuidSchema } from '@managedops/shared';
import { Audited, CurrentUser } from '../../common/decorators/index.js';
import { validate } from '../../common/pipes/zod-validation.pipe.js';
import { FilesService } from './files.service.js';
import { confirmUploadSchema, uploadUrlSchema, type UploadUrlInput } from './file-policy.js';

@ApiTags('files')
@ApiBearerAuth()
@Audited('FileObject')
@Controller('api/v1/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a presigned URL to upload a file straight to storage' })
  createUploadUrl(
    @Body(validate(uploadUrlSchema)) body: UploadUrlInput,
    @CurrentUser('userId') userId: string,
  ) {
    return this.files.createUploadUrl(body, userId);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an upload finished; verifies size and real file type' })
  confirm(
    @Param('id', validate(uuidSchema)) id: string,
    @Body(validate(confirmUploadSchema)) body: { checksumSha256?: string },
    @CurrentUser('userId') userId: string,
  ) {
    return this.files.confirmUpload(id, userId, body.checksumSha256);
  }

  @Get(':id/download-url')
  @ApiOperation({ summary: 'Get a short-lived download URL; the access is audited' })
  download(@Param('id', validate(uuidSchema)) id: string, @CurrentUser('userId') userId: string) {
    return this.files.createDownloadUrl(id, userId);
  }
}
