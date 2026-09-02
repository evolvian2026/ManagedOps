resource "aws_ses_domain_identity" "this" {
  domain = var.domain_name
}

resource "aws_ses_domain_dkim" "this" {
  domain = aws_ses_domain_identity.this.domain
}

# The three CNAMEs SES needs are emitted as an output rather than created here,
# because the DNS zone is usually somebody else's and Terraform reaching into it
# is how a shared zone gets broken.
