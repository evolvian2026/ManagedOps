import { Global, Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { FileAccessPolicy } from './file-access.js';

@Global()
@Module({
  controllers: [FilesController],
  providers: [FilesService, FileAccessPolicy],
  exports: [FilesService],
})
export class FilesModule {}
