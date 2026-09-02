import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DOWNLOAD_URL_TTL_SECONDS } from '@managedops/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { newId } from '../../common/ids.js';
import { NotFoundProblem, ValidationProblem } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import {
  MAGIC_BYTE_WINDOW,
  UPLOAD_POLICY,
  humanSize,
  matchesMagicBytes,
  sanitiseFileName,
  type UploadUrlInput,
} from './file-policy.js';

/** Long enough for a slow mobile upload, short enough that a leaked URL dies. */
const UPLOAD_URL_TTL_SECONDS = 300;

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    const s3 = config.getOrThrow<{
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle: boolean;
    }>('s3');

    this.bucket = s3.bucket;
    this.s3 = new S3Client({
      region: s3.region,
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      forcePathStyle: s3.forcePathStyle,
      ...(s3.accessKeyId && s3.secretAccessKey
        ? { credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } }
        : {}),
    });
  }

  /**
   * Issues a presigned PUT so the browser uploads straight to object storage.
   * The API never handles file bytes, which keeps large uploads off the request
   * path entirely.
   */
  async createUploadUrl(input: UploadUrlInput, uploaderId: string) {
    const policy = UPLOAD_POLICY[input.purpose];
    const purpose = input.purpose.replace(/_/g, ' ');

    if (!policy.mimeTypes.includes(input.mimeType)) {
      throw new ValidationProblem(`A ${purpose} must be one of: ${policy.mimeTypes.join(', ')}.`, [
        { path: 'mimeType', message: `${input.mimeType} is not accepted here` },
      ]);
    }
    if (input.sizeBytes > policy.maxBytes) {
      throw new ValidationProblem(
        `That file is ${humanSize(input.sizeBytes)}. The limit for a ${purpose} is ${humanSize(policy.maxBytes)}.`,
        [{ path: 'sizeBytes', message: `exceeds ${humanSize(policy.maxBytes)}` }],
      );
    }

    const id = newId();
    const storageKey = `${policy.prefix}/${id}/${sanitiseFileName(input.fileName)}`;

    const file = await this.prisma.db.fileObject.create({
      data: {
        id,
        storageKey,
        originalName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        uploadedById: uploaderId,
      },
      select: { id: true, storageKey: true, originalName: true, mimeType: true, sizeBytes: true },
    });

    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ContentType: input.mimeType,
        ServerSideEncryption: 'AES256',
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );

    return { file, uploadUrl, expiresIn: UPLOAD_URL_TTL_SECONDS, maxBytes: policy.maxBytes };
  }

  /**
   * Called once the browser's PUT succeeds. This is where the upload is really
   * checked: the object must exist, its actual size must be within the policy
   * for its purpose, and its leading bytes must match the type it claims to be —
   * renaming a file does not change its format.
   */
  async confirmUpload(fileId: string, uploaderId: string, checksum?: string) {
    const file = await this.prisma.db.fileObject.findUnique({ where: { id: fileId } });
    if (!file || file.uploadedById !== uploaderId) throw new NotFoundProblem('That upload');
    if (file.confirmedAt) return { id: file.id, confirmed: true };

    const head = await this.s3
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: file.storageKey }))
      .catch(() => null);

    if (!head) {
      throw new ValidationProblem('That file was not received. Upload it again.', [
        { path: 'fileId', message: 'no object found in storage' },
      ]);
    }

    // Re-check the real size: the declared size in step one is only a client claim.
    const actualSize = head.ContentLength ?? 0;
    const policy = this.policyForKey(file.storageKey);
    if (actualSize > policy.maxBytes) {
      await this.discard(file.id);
      throw new ValidationProblem(
        `That file is ${humanSize(actualSize)}, over the ${humanSize(policy.maxBytes)} limit.`,
        [{ path: 'fileId', message: 'larger than the declared size allows' }],
      );
    }

    if (!(await this.hasExpectedMagicBytes(file.storageKey, file.mimeType))) {
      await this.discard(file.id);
      const extension = file.mimeType.split('/').pop()?.toUpperCase() ?? 'file';
      throw new ValidationProblem(
        `That file is not really a ${extension}. Renaming a file does not change its format.`,
        [{ path: 'fileId', message: 'content does not match its declared type' }],
      );
    }

    await this.prisma.db.fileObject.update({
      where: { id: file.id },
      data: {
        confirmedAt: new Date(),
        sizeBytes: actualSize,
        checksumSha256: checksum ?? null,
        // Antivirus scanning is deferred to v1.1; recording `skipped` is honest
        // about that rather than claiming a scan that never ran.
        scanStatus: 'skipped',
      },
    });

    return { id: file.id, confirmed: true };
  }

  /** Attaches a confirmed upload to the record that owns it. */
  async attach(fileId: string, ownerType: string, ownerId: string): Promise<void> {
    await this.prisma.db.fileObject.update({
      where: { id: fileId },
      data: { ownerType, ownerId },
    });
  }

  /** Guards against a record referencing an upload that never completed. */
  async requireConfirmed(fileId: string): Promise<void> {
    const file = await this.prisma.db.fileObject.findUnique({
      where: { id: fileId },
      select: { confirmedAt: true },
    });
    if (!file) throw new NotFoundProblem('That file');
    if (!file.confirmedAt) {
      throw new ValidationProblem('That upload has not finished. Try again in a moment.', [
        { path: 'fileId', message: 'upload not confirmed' },
      ]);
    }
  }

  /**
   * Short-lived presigned GET. Every issue is audited, because this is the
   * moment somebody actually reads an identity document.
   */
  async createDownloadUrl(fileId: string, actorUserId: string) {
    const file = await this.prisma.db.fileObject.findUnique({ where: { id: fileId } });
    if (!file || !file.confirmedAt) throw new NotFoundProblem('That file');

    const downloadUrl = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: file.storageKey,
        ResponseContentDisposition: `attachment; filename="${sanitiseFileName(file.originalName)}"`,
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );

    await this.audit.record({
      actorUserId,
      action: 'FILE_DOWNLOADED',
      entityType: file.ownerType ?? 'FileObject',
      entityId: file.ownerId ?? file.id,
      after: { fileId: file.id, originalName: file.originalName },
    });

    return {
      downloadUrl,
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      fileName: file.originalName,
      mimeType: file.mimeType,
    };
  }

  /** Uploads never attached to a record, swept weekly by the worker. */
  async findOrphans(olderThan: Date, limit = 500) {
    return this.prisma.db.fileObject.findMany({
      where: { ownerId: null, createdAt: { lt: olderThan } },
      select: { id: true, storageKey: true },
      take: limit,
    });
  }

  async markDeleted(fileIds: string[]): Promise<number> {
    if (fileIds.length === 0) return 0;
    const result = await this.prisma.db.fileObject.updateMany({
      where: { id: { in: fileIds } },
      data: { deletedAt: new Date() },
    });
    return result.count;
  }

  /** Readiness probe: a 404 or 403 for the probe key still proves it answered. */
  async isReachable(): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: '__probe__' }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      return status === 404 || status === 403;
    }
  }

  private policyForKey(storageKey: string) {
    const prefix = storageKey.split('/')[0];
    return (
      Object.values(UPLOAD_POLICY).find((policy) => policy.prefix === prefix) ??
      UPLOAD_POLICY.identity_document
    );
  }

  private async hasExpectedMagicBytes(storageKey: string, mimeType: string): Promise<boolean> {
    try {
      const object = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          Range: `bytes=0-${MAGIC_BYTE_WINDOW - 1}`,
        }),
      );
      const bytes = await object.Body?.transformToByteArray();
      if (!bytes) return false;
      return matchesMagicBytes(mimeType, Buffer.from(bytes));
    } catch (error) {
      this.logger.error({ err: error, storageKey }, 'Could not read upload for verification');
      return false;
    }
  }

  private async discard(fileId: string): Promise<void> {
    await this.prisma.db.fileObject.update({
      where: { id: fileId },
      data: { deletedAt: new Date() },
    });
  }
}
