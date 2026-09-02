# Restoring from backup

**When:** data has been lost or corrupted and the right answer is "put it back
as it was at a point in time" — a bad migration, a mistaken bulk change, a
deletion nobody meant.

**Cost:** the application is down for the whole restore, and everything written
after the chosen point in time is lost. Both are real. Read step 1 before doing
anything else.

**Time:** 20 to 40 minutes, mostly waiting for RDS.

## 1. Decide, before you start

Answer these out loud, to another person if one is awake:

- **What exactly is wrong?** A restore fixes "the data used to be right". It
  does not fix a bug that will corrupt it again in an hour.
- **What time was it last right?** RDS point-in-time recovery goes to the
  second, within the 7-day window.
- **What will be lost?** Everything written between that moment and now. On a
  working day that is punches, leave decisions and uploads. Say the number of
  hours out loud.
- **Is there a narrower fix?** One wrong row is a `UPDATE`, not a restore.

If a narrower fix exists, take it. A restore is the largest hammer in the
building.

## 2. Stop the application

Writing to a database that is about to be replaced only widens the loss.

```bash
aws ssm start-session --target <instance-id>
sudo -i && cd /opt/managedops
docker compose stop api worker
```

Leave `caddy` running: it will serve a 502, which is a truer thing for a user to
see than a page that half works.

## 3. Restore to a new instance

RDS restores alongside rather than in place, which is what makes this reversible.

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier managedops-production \
  --target-db-instance-identifier managedops-production-restore \
  --restore-time 2026-09-02T09:15:00Z \
  --db-subnet-group-name managedops-production \
  --vpc-security-group-ids <db-security-group-id> \
  --no-publicly-accessible

aws rds wait db-instance-available \
  --db-instance-identifier managedops-production-restore
```

## 4. Check it before you trust it

Point at the restored instance and look. Do not skip this.

```bash
psql "$RESTORED_URL" -c "select max(\"createdAt\") from audit_logs;"
psql "$RESTORED_URL" -c "select count(*) from attendance_records where \"workDate\" = current_date;"
```

The latest audit entry should sit just before your chosen time. If it does not,
you restored to the wrong moment — the restored instance is disposable, so do it
again rather than proceeding.

## 5. Cut over

```bash
aws secretsmanager put-secret-value \
  --secret-id managedops-production/database \
  --secret-string "{\"DATABASE_URL\":\"$RESTORED_URL\"}"

systemctl restart managedops-env managedops
```

Migrations run on start; a restored database at an older schema catches up.

## 6. Verify and finish

```bash
curl -sf https://managedops.example.com/ready
```

Sign in, open Running Projects and the Audit Log. Then:

- Rename the instances so the restored one is the canonical name, or leave the
  new name and update Terraform — but do not leave the two disagreeing.
- **Tell people what was lost.** Anyone who punched in during the lost window
  has to do it again, and they will not know unless somebody says so.
- Keep the old instance for a week before deleting it.
