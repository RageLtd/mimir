---
tools: ["Bash"]
---
# Do Not Reshape a Pull Request To Work Around a Platform Bug

Closing, reopening, or retargeting a pull request are not diagnostic tools. Reach for them to shake loose a stuck check and you trade a cosmetic problem for a real one.

Each has consequences outside the pull request:

- **Closing** destroys ephemeral infrastructure bound to it. Preview environments are deleted, and the replacement may return under a different name — breaking any CI step that resolves it by name, and stranding deployment records that point at the environment that no longer exists.
- **Retargeting** changes what the diff means to every reviewer who has already read it.
- **Force-pushing** orphans review threads against commits that no longer exist.

Reopening restores the pull request. It does not restore what closing destroyed.

When the platform reports something impossible — a conflict on a fast-forward, a check that never queues, a merge state that contradicts `git merge-tree` — gather the evidence and report it. Fix the underlying state instead: land the parent branch, update the base, wait for the queue. If none of those apply, hand it to a human with what you found.

A stuck badge is cosmetic. Deleting a deployed environment is not.
