# Runbooks

Four things go wrong with a system this size, and these are the four. Each one
is written to be followed at 2am by somebody who did not build it: exact
commands, what "it worked" looks like, and what to do when it did not.

| Runbook                                            | When you need it                                      |
| -------------------------------------------------- | ----------------------------------------------------- |
| [`rollback.md`](rollback.md)                       | A deploy made things worse                            |
| [`restore-from-backup.md`](restore-from-backup.md) | Data is gone or wrong and the fix is a point in time  |
| [`rotate-credentials.md`](rotate-credentials.md)   | A secret leaked, or it is simply time                 |
| [`incident-response.md`](incident-response.md)     | Something is down or slow and you do not yet know why |

## Getting onto the host

There is no SSH key and no open port 22. Access is Session Manager, which needs
no inbound path and leaves a record of who connected:

```bash
aws ssm start-session --target "$(terraform -chdir=infra/terraform output -raw instance_id)"
sudo -i
cd /opt/managedops
```

If Session Manager cannot reach the instance, the SSM agent is down — which
usually means the host itself is, and that is `incident-response.md`.
