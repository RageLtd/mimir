---
description: Turn Mimir off for this project — removes the plugin enablement and the Mimir output style from .claude/settings.local.json
allowed-tools: ["Bash"]
---

You are turning Mimir off for the current project. The switch is this project's `.claude/settings.local.json`: `mimir-cc enable` added the plugin, the "Mimir" output style, and a few settings there, and `disable` removes exactly those entries — anything the developer added or changed since is kept.

Run:

```bash
"$HOME/.local/bin/mimir-cc" disable
```

Show the output verbatim. If it exited non-zero, surface the error and do not invent a remediation.

If it exited zero, tell the user:

> Mimir is off for this project from the next session. Running sessions keep their current configuration. To turn it back on later, run `~/.local/bin/mimir-cc enable` from inside the project.
