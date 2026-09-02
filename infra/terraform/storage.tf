# Uploads: résumés, identity documents, receipts. Private, versioned, and
# lifecycle-ruled so a deleted document is recoverable for a while and gone
# eventually (spec 7.4).

resource "aws_s3_bucket" "uploads" {
  bucket = "${local.name}-uploads"

  tags = { Name = "${local.name}-uploads" }
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  versioning_configuration {
    # A document deleted by mistake is recoverable; the lifecycle rule below is
    # what stops versions accumulating forever.
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Presigned PUTs come from the browser, so the bucket has to allow the app's
# origin — and only that origin.
resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = ["https://${var.domain_name}"]
    allowed_headers = ["content-type"]
    expose_headers  = ["etag"]
    max_age_seconds = 3000
  }
}
