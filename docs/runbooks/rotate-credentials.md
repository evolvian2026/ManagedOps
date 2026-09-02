# Rotating credentials

**When:** a secret has leaked, somebody with access has left, or it is simply
time. Rotate on suspicion — the cost is a restart.

Every credential is a Secrets Manager entry the host reads at boot, so rotating
one is: change the value, restart, verify. Nothing is baked into an image.

## What exists

| Secret                           | Holds                                            | Rotating it costs                  |
| -------------------------------- | ------------------------------------------------ | ---------------------------------- |
| `managedops-production/app`      | `JWT_ACCESS_SECRET`                              | Every signed-in user is signed out |
| `managedops-production/database` | `DATABASE_URL`                                   | ~20 seconds of downtime            |
| SES                              | Nothing — the host sends under its instance role | Nothing to rotate                  |
| S3                               | Nothing — same                                   | Nothing to rotate                  |

The last two rows are the point of using an instance role: there is no key to
leak, so there is no key to rotate.

## Rotating the JWT signing key

Every access token is signed with it, so changing it invalidates all of them.
Refresh cookies survive — they are opaque and stored hashed — so most users are
silently refreshed rather than bounced to the login page. Do it anyway if the
key is suspect.

```bash
NEW_SECRET=$(openssl rand -hex 48)

aws secretsmanager put-secret-value \
  --secret-id managedops-production/app \
  --secret-string "{\"JWT_ACCESS_SECRET\":\"$NEW_SECRET\"}"

aws ssm start-session --target <instance-id>
sudo systemctl restart managedops-env managedops
```

Verify by signing in. An existing tab that keeps working is the refresh flow
doing its job, not the rotation failing.

## Rotating the database password

RDS changes the password on the instance; Secrets Manager carries it to the app.
Do both, in this order, or the application will not be able to connect.

```bash
NEW_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)

aws rds modify-db-instance \
  --db-instance-identifier managedops-production \
  --master-user-password "$NEW_PASSWORD" \
  --apply-immediately

aws rds wait db-instance-available --db-instance-identifier managedops-production

ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier managedops-production \
  --query 'DBInstances[0].Endpoint.Address' --output text)

aws secretsmanager put-secret-value \
  --secret-id managedops-production/database \
  --secret-string "{\"DATABASE_URL\":\"postgresql://managedops:$NEW_PASSWORD@$ENDPOINT:5432/managedops?schema=public&sslmode=require\"}"

aws ssm start-session --target <instance-id>
sudo systemctl restart managedops-env managedops
```

```bash
curl -sf https://managedops.example.com/ready
```

`ready` checks the database, so a 200 means the new password took.

**Terraform will notice.** It generated the original password and still holds it
in state. Either `terraform apply` to put its own value back — a second
rotation, at the cost of another restart — or run
`terraform state rm random_password.database` and manage the value by hand from
here. Choose one deliberately; leaving them disagreeing means the next unrelated
apply rotates the password by surprise.

## Revoking one person's access

Rotating shared secrets is not how you remove a person.

- **A ManagedOps account:** disable it on the Users screen. Their refresh token
  is revoked and they are out within fifteen minutes, when the access token
  expires.
- **AWS access:** remove their IAM user or their SSO assignment.
- **A departing engineer who saw the secrets:** rotate both entries above.
