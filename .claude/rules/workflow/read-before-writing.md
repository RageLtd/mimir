# Read Before Writing

**Before writing code that calls another service, API, CLI tool, or route: read the target's source code or docs first.** Do not guess at URLs, flag names, route paths, port numbers, or parameter formats.

## Rules

1. **HTTP calls**: Read the target service's route definitions for the exact path.
2. **CLI flags**: Run `--help` first. Do not assume flag names or syntax.
3. **Service architecture**: Check deployment config (docker-compose, workflow files) before assuming topology.
4. **URLs**: Verify host, port, and protocol from actual config.

## Stop-After-Failure

After **1 failed attempt**: Stop. Re-read source code, config, or docs. Resume only with evidence for why it failed.

After **2 failed attempts**: Stop and reconsider the entire approach. Ask the user rather than trying a 3rd variation.

## Anti-Patterns

- "The route is probably `/login`" -> code -> 404 -> "oh, it's `/auth/login`"
- "This flag probably works like..." -> error -> try another -> error -> try another
- User says "do X" -> "X won't work" -> do Y -> fail -> do Z -> fail -> finally do X
