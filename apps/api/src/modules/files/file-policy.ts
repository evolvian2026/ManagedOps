import { z } from 'zod';

/**
 * Upload policy (spec 7.4). Each purpose declares the MIME types it accepts, a
 * size ceiling justified by what the document actually is, and the magic bytes
 * every accepted type must begin with — extension and client-declared MIME type
 * are both trivially forged, so neither is trusted on its own.
 */
export const UPLOAD_PURPOSES = [
  'resume',
  'identity_document',
  'certificate',
  'reimbursement_proof',
  'deliverable',
  'offer_attachment',
] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

const MB = 1024 * 1024;

const PDF = 'application/pdf';
const JPEG = 'image/jpeg';
const PNG = 'image/png';
const DOC = 'application/msword';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPT = 'application/vnd.ms-powerpoint';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface PurposePolicy {
  maxBytes: number;
  mimeTypes: readonly string[];
  /** Where uploads for this purpose are keyed under in the bucket. */
  prefix: string;
}

export const UPLOAD_POLICY: Readonly<Record<UploadPurpose, PurposePolicy>> = {
  // A text CV is well under 1 MB; 5 MB tolerates embedded images.
  resume: { maxBytes: 5 * MB, mimeTypes: [PDF, DOC, DOCX], prefix: 'resumes' },
  // A phone photo of an ID card runs 2-4 MB.
  identity_document: { maxBytes: 5 * MB, mimeTypes: [JPEG, PNG, PDF], prefix: 'identity' },
  // Multi-page scanned certificates.
  certificate: {
    maxBytes: 10 * MB,
    mimeTypes: [PDF, JPEG, PNG, DOC, DOCX],
    prefix: 'certificates',
  },
  // Receipt photos.
  reimbursement_proof: { maxBytes: 5 * MB, mimeTypes: [JPEG, PNG, PDF], prefix: 'claims' },
  // Course material, which legitimately carries slides.
  deliverable: {
    maxBytes: 25 * MB,
    mimeTypes: [PDF, DOC, DOCX, PPT, PPTX, XLSX],
    prefix: 'deliverables',
  },
  offer_attachment: { maxBytes: 5 * MB, mimeTypes: [PDF], prefix: 'offers' },
};

/** Leading bytes each accepted container must start with. */
const MAGIC_BYTES: Record<string, readonly number[][]> = {
  [PDF]: [[0x25, 0x50, 0x44, 0x46]], // %PDF
  [JPEG]: [[0xff, 0xd8, 0xff]],
  [PNG]: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  [DOC]: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], // OLE2 compound file
  [PPT]: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  // The OOXML formats are all ZIP containers.
  [DOCX]: [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
  ],
  [PPTX]: [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
  ],
  [XLSX]: [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
  ],
};

export function matchesMagicBytes(mimeType: string, head: Buffer): boolean {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;
  return signatures.some((signature) => signature.every((byte, index) => head[index] === byte));
}

/** Longest signature we compare against, so callers know how much to read. */
export const MAGIC_BYTE_WINDOW = 16;

export const uploadUrlSchema = z
  .object({
    purpose: z.enum(UPLOAD_PURPOSES),
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(160),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;

export const confirmUploadSchema = z
  .object({
    checksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Expected a hex SHA-256 digest')
      .optional(),
  })
  .strict();

export function humanSize(bytes: number): string {
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

/** Strips path separators and control characters from a client-supplied name. */
export function sanitiseFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f"']/g, '')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'file';
}
