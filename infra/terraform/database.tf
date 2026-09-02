resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = var.private_subnet_ids

  description = "Private subnets — the database has no route from the internet"
}

resource "random_password" "database" {
  length  = 40
  special = false # RDS rejects several punctuation characters in a master password.
}

resource "aws_db_instance" "this" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 5
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = replace(var.project, "-", "_")
  username = "managedops"
  password = random_password.database.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false

  backup_retention_period = var.backup_retention_days
  backup_window           = "18:30-19:30" # 00:00–01:00 IST, the quietest hour.
  maintenance_window      = "sun:19:30-sun:20:30"
  copy_tags_to_snapshot   = true

  # Production keeps a final snapshot; staging does not, because a staging
  # database nobody would restore is a snapshot bill nobody notices.
  skip_final_snapshot       = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${local.name}-final" : null
  deletion_protection       = var.environment == "production"

  auto_minor_version_upgrade      = true
  performance_insights_enabled    = var.environment == "production"
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Applying a change immediately would restart the database mid-afternoon.
  apply_immediately = false

  tags = { Name = local.name }
}
