# Every credential the application reads at boot. Terraform creates the
# containers and knows their ARNs; it never knows their contents, which are set
# out of band. A secret in state is a secret in every plan output and every
# state backup.

resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "JWT signing key and anything else the API needs at boot"

  recovery_window_in_days = var.environment == "production" ? 30 : 0
}

resource "aws_secretsmanager_secret" "database" {
  name        = "${local.name}/database"
  description = "Connection string for the RDS instance"

  recovery_window_in_days = var.environment == "production" ? 30 : 0
}

# The database password is generated here, so this one value Terraform does
# know — writing it to Secrets Manager is what keeps it out of the deploy
# pipeline and off anybody's laptop.
resource "aws_secretsmanager_secret_version" "database" {
  secret_id = aws_secretsmanager_secret.database.id

  secret_string = jsonencode({
    DATABASE_URL = join("", [
      "postgresql://",
      aws_db_instance.this.username,
      ":",
      random_password.database.result,
      "@",
      aws_db_instance.this.endpoint,
      "/",
      aws_db_instance.this.db_name,
      "?schema=public&sslmode=require",
    ])
  })
}
