# ManagedOps infrastructure

One EC2 host running Docker Compose, an RDS PostgreSQL instance in a private
subnet, a private S3 bucket, SES for transactional mail, and Secrets Manager for
every credential. That is the whole estate, and it is deliberately small.

## Why one host

A single instance cannot do zero-downtime deployment: a deploy costs roughly
10–20 seconds of unavailability while the containers restart. For an internal
tool serving a few hundred people that is a better trade than an ALB, a second
instance and the operational surface both bring — see specification §12.5.

The upgrade path needs no application change, only Terraform, because the
application holds no local state: put an ALB in front, raise `instance_count`,
switch the deploy to rolling. Nothing in `apps/api` knows how many copies of
itself are running.

## Layout

| File            | What it holds                                                 |
| --------------- | ------------------------------------------------------------- |
| `main.tf`       | Providers, the VPC data lookups, and locals                   |
| `network.tf`    | Security groups — the only inbound path is 80/443 to the host |
| `database.tf`   | RDS PostgreSQL 16, private, backed up, encrypted              |
| `storage.tf`    | The uploads bucket: private, versioned, lifecycle-ruled       |
| `compute.tf`    | The EC2 host, its instance profile and its IAM policy         |
| `email.tf`      | SES identity and the sending policy                           |
| `secrets.tf`    | Secrets Manager entries the host may read                     |
| `monitoring.tf` | CloudWatch log groups and the alarms worth waking someone for |
| `variables.tf`  | Every input, with a comment saying why it exists              |
| `outputs.tf`    | What the deploy pipeline needs to know                        |

## Running it

```bash
cd infra/terraform
terraform init
terraform plan  -var-file=env/production.tfvars
terraform apply -var-file=env/production.tfvars
```

State belongs in S3 with DynamoDB locking; `backend.tf.example` shows the shape.
It is an example rather than the real thing because the bucket has to exist
before Terraform can store state in it, and bootstrapping that is a one-off.

## What is deliberately not here

- **No Kubernetes.** Three containers on one host do not need an orchestrator.
- **No autoscaling group.** Scaling this is a capacity decision somebody makes
  once a year, not a thing to automate against traffic that does not spike.
- **No secrets in state.** Values are created empty and populated out of band;
  Terraform knows the ARNs, never the contents.
