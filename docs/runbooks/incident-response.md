# Something is wrong and you do not know what

**When:** users report errors or slowness, or an alarm fired, and no deploy
explains it.

The order below is deliberate: cheapest and most likely first.

## 1. Is it up at all?

```bash
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://managedops.example.com/
curl -sS https://managedops.example.com/ready
```

- **`/ready` returns 503** — it names the failing dependency. Go to that section.
- **Connection refused or a timeout** — the host or Caddy is down. Step 2.
- **Both fine but users disagree** — it is a specific screen, not the system.
  Get the exact URL and the trace id from the error panel; every Problem Details
  response carries one, and it appears in the logs.

## 2. Is the host healthy?

```bash
aws ssm start-session --target <instance-id>
sudo -i

systemctl status managedops
docker compose ps
df -h /
free -m
```

**A full disk** is the most common cause of an inexplicable failure on a host
like this, and it is almost always Docker images:

```bash
docker system prune -af --filter "until=168h"
```

**A container restarting** shows its reason in the last fifty lines:

```bash
docker compose logs --tail=50 api
```

## 3. Is it the database?

```bash
docker compose exec api node -e "
  const { PrismaClient } = require('@prisma/client');
  new PrismaClient().\$queryRaw\`select 1\`.then(() => console.log('ok')).catch(e => console.error(e.message));
"
```

Then in the RDS console: CPU, free storage, connection count. A saturated
connection pool looks exactly like slowness in the application.

```sql
-- What is running right now, longest first.
select pid, now() - query_start as duration, state, left(query, 120)
from pg_stat_activity
where state <> 'idle' and query not ilike '%pg_stat_activity%'
order by duration desc
limit 20;
```

A query minutes old with no index behind it is the usual answer. Do not kill it
without noting what it was — it will come back.

## 4. Read the logs properly

Logs are JSON with a request id on every line, so query them rather than
grepping.

```
fields @timestamp, req.id, req.method, req.url, res.statusCode, responseTime, msg
| filter res.statusCode >= 500
| sort @timestamp desc
| limit 50
```

To follow one failing request end to end, filter on the trace id the user was
shown:

```
fields @timestamp, msg, @message
| filter req.id = "<trace-id>"
| sort @timestamp asc
```

## 5. Is it the scheduled work?

The worker is a separate container, and a stuck job does not show up as an HTTP
error — it shows up as attendance days that never closed or leave that never
escalated.

```bash
docker compose logs --since 24h worker | grep -i "job failed"
```

pg-boss keeps its queue in PostgreSQL, so the state is inspectable:

```sql
select name, state, count(*)
from pgboss.job
group by 1, 2
order by 3 desc;
```

Jobs are written to be idempotent, so re-running one is safe.

## 6. When to stop investigating and act

If users are affected and you have been looking for fifteen minutes without an
answer:

- **A deploy went out today** — roll back (`rollback.md`) and investigate after.
- **No deploy** — restart the application: `systemctl restart managedops`. It
  costs twenty seconds and clears a surprising number of states.
- **Neither helps** — escalate. Somebody who knows the system is a better use of
  the next fifteen minutes than another log query.

## Afterwards

Write down what happened, what fixed it, and what would have caught it sooner —
before you go back to sleep, while you still know. An incident nobody wrote down
happens twice.
