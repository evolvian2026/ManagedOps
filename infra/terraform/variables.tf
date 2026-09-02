variable "project" {
  description = "Name prefix on every resource, so a bill can be read by service."
  type        = string
  default     = "managedops"
}

variable "environment" {
  description = "staging or production. Staging runs the same shape at a smaller size."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  description = "ap-south-1 — the data and the people are both in India."
  type        = string
  default     = "ap-south-1"
}

variable "vpc_id" {
  description = "An existing VPC. This stack does not own the network it sits in."
  type        = string
}

variable "public_subnet_ids" {
  description = "Where the application host goes. One is enough for a single host."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Where the database goes. Two, in different zones, because RDS insists."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "RDS needs subnets in at least two availability zones."
  }
}

variable "instance_type" {
  description = "t3.medium holds three containers with room to spare (spec 1.4)."
  type        = string
  default     = "t3.medium"
}

variable "db_instance_class" {
  description = "db.t4g.micro is ample for a few hundred users; raise it before it hurts."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Gigabytes. Storage autoscaling raises it; it never falls."
  type        = number
  default     = 20
}

variable "backup_retention_days" {
  description = "Point-in-time recovery window. Seven days covers a Friday mistake found on Monday."
  type        = number
  default     = 7
}

variable "domain_name" {
  description = "The hostname Caddy gets a certificate for."
  type        = string
}

variable "mail_from_address" {
  description = "The From address on every transactional mail. Must be a verified SES identity."
  type        = string
}

variable "alarm_email" {
  description = "Where an alarm goes. An alarm nobody receives is a log line."
  type        = string
}

variable "ssh_ingress_cidrs" {
  description = <<-EOT
    Who may reach SSH. Default is nobody: deploys run over SSM, and an open
    port 22 is the most common way a host like this is lost. Set it to an
    office range only if you have accepted that trade deliberately.
  EOT
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Extra tags merged onto every resource."
  type        = map(string)
  default     = {}
}
