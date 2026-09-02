# The application host. Its instance profile is the whole of its authority: read
# its own secrets, read and write its own bucket prefix, send mail as its own
# identity, write its own logs. Nothing wildcarded, nothing borrowed.

resource "aws_iam_role" "app" {
  name = "${local.name}-app"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

# Deploys and break-glass shells go through Session Manager, which is why no
# port 22 is open by default and why there is no shared SSH key to rotate.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn, aws_secretsmanager_secret.database.arn]
  }

  statement {
    sid     = "UseOwnBucket"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    # Objects only. Bucket-level permissions are a separate statement so a
    # mistake in one cannot silently widen the other.
    resources = ["${aws_s3_bucket.uploads.arn}/*"]
  }

  statement {
    sid       = "ListOwnBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.uploads.arn]
  }

  statement {
    sid       = "SendMailAsSelf"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [aws_ses_domain_identity.this.arn]
  }

  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${local.name}-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name}-app"
  role = aws_iam_role.app.name
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.instance_type
  subnet_id              = var.public_subnet_ids[0]
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name

  # IMDSv2 only: the token requirement is what stops a server-side request
  # forgery in the application from reading the instance's credentials.
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 40
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    region             = var.region
    app_secret_arn     = aws_secretsmanager_secret.app.arn
    db_secret_arn      = aws_secretsmanager_secret.database.arn
    bucket             = aws_s3_bucket.uploads.bucket
    domain_name        = var.domain_name
    mail_from_address  = var.mail_from_address
    log_group          = aws_cloudwatch_log_group.app.name
  })

  # Changing user data replaces the host, which is the honest behaviour: the
  # bootstrap script is how the host is configured, so an edited script that
  # never ran describes a machine that does not exist.
  user_data_replace_on_change = true

  tags = { Name = "${local.name}-app" }
}

resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  # The address outlives the instance, so DNS survives a replacement.
  tags = { Name = "${local.name}-app" }
}
