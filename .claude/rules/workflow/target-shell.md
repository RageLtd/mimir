# Know the Target Shell

Before writing a script or handing over a command to run, know which shell will execute it.

- Assume `zsh`. Verify once per session (`echo $SHELL`) and reuse that answer — do not re-check per command.
- Give scripts an explicit shebang for the shell they were written against. A `bash` script invoked as `sh` is a different language.
- Prefer POSIX-compatible constructs where the shells diverge. Common traps: unmatched globs (zsh errors, bash passes the pattern through), `read -a` vs `read -A`, arrays indexed from 0 vs 1, `shopt` vs `setopt`.
