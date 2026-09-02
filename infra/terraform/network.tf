# The only inbound path to the application is 80 and 443 on the host. Everything
# else — the database, the queue, the object store — is reached from inside.

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "ManagedOps application host"
  vpc_id      = var.vpc_id

  tags = { Name = "${local.name}-app" }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.app.id
  description       = "HTTP, which Caddy redirects to HTTPS and uses for ACME"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Empty by default. Deploys go over SSM Session Manager, which needs no open
# port and leaves an audit trail that a shared SSH key does not.
resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each = toset(var.ssh_ingress_cidrs)

  security_group_id = aws_security_group.app.id
  description       = "SSH, only if someone deliberately opened it"
  cidr_ipv4         = each.value
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "app_out" {
  security_group_id = aws_security_group.app.id
  description       = "Outbound to AWS services and the public internet"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "database" {
  name        = "${local.name}-db"
  description = "ManagedOps database"
  vpc_id      = var.vpc_id

  tags = { Name = "${local.name}-db" }
}

# The database accepts connections from the application host and from nothing
# else — not from the VPC at large, which is the usual over-broad shortcut.
resource "aws_vpc_security_group_ingress_rule" "postgres" {
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from the application host only"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
