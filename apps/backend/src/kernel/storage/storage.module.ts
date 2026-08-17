import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/**
 * kernel/storage — `StorageService`: MinIO presigned upload/download,
 * image compression, EXIF strip, and the `attachments` table (BUILD-PLAN §5
 * W2-C). Backs `POST /api/attachments/presign`, `.../confirm`,
 * `GET .../url` (CONTRACTS.md §4.0). See `storage.service.ts` for the full
 * upload-flow design and `image-processing.util.ts` for the compression/
 * EXIF-strip pipeline every *wajib foto* endpoint relies on.
 */
@Module({
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
