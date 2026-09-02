output "app_public_ip" {
  description = "Point the A record here. It survives replacing the instance."
  value       = aws_eip.app.public_ip
}

output "instance_id" {
  description = "For `aws ssm start-session --target <id>` — see the runbooks."
  value       = aws_instance.app.id
}

output "database_endpoint" {
  description = "Host and port. The credentials live in Secrets Manager, not here."
  value       = aws_db_instance.this.endpoint
}

output "uploads_bucket" {
  description = "The bucket the API presigns against."
  value       = aws_s3_bucket.uploads.bucket
}

output "app_secret_arn" {
  description = "Populate this out of band before the first boot."
  value       = aws_secretsmanager_secret.app.arn
}

output "ses_dkim_records" {
  description = "Three CNAMEs to add to the DNS zone before mail will send."
  value = [
    for token in aws_ses_domain_dkim.this.dkim_tokens :
    {
      name  = "${token}._domainkey.${var.domain_name}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }
  ]
}

output "log_group" {
  description = "Where the containers ship their JSON logs."
  value       = aws_cloudwatch_log_group.app.name
}
