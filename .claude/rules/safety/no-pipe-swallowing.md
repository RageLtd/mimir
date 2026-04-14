# No Pipe Swallowing

Do not pipe command output directly into `head`, `tail`, `grep`, `wc`, or other filters. If the command fails, the pipe silently swallows stderr or returns misleading results.

## Wrong

```bash
atlas schema inspect --env local 2>&1 | grep -c 'table "'
atlas schema apply --dry-run 2>&1 | head -5
some-command 2>&1 | tail -20
```

## Correct

Run the command first, capture output, then filter:

```bash
atlas schema inspect --env local > /tmp/out.txt 2>&1
grep -c 'table "' /tmp/out.txt

atlas schema apply --dry-run 2>&1
# Then filter in a separate command
```
