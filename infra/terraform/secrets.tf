# Every credential the application reads at boot. Terraform creates the
# containers and knows their ARNs; it never knows their contents, which are set
# out of band. A secret in state is a secret in every plan output and every
# state backup.

# Holds JWT_ACCESS_SECRET, MFA_SECRET_KEY, and the messaging provider's
# credentials. MFA_SECRET_KEY is what stands between a database dump and
# somebody minting codes for every privileged account, so it belongs here rather
# than in the task definition's environment where a describe-tasks call would
# print it.
resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "JWT signing key, MFA encryption key, messaging credentials"

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
