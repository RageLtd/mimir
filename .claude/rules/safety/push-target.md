---
tools: ["Bash"]
---
# A Branch Pushes To Its Own Name

Never push with a `<source>:<destination>` refspec, and never create a branch that inherits a different branch's upstream. Both end with unready work on `main`.

The failure is a chain, and it starts at branch creation:

1. `git checkout -b fix/thing origin/main` (or `git worktree add … -b fix/thing origin/main`) sets `fix/thing`'s upstream to `origin/main` — `branch.autoSetupMerge` defaults to `true`.
2. `git push` then refuses, because `push.default=simple` will not push a branch to a differently-named upstream.
3. Git's own error suggests `git push origin HEAD:main`.
4. Pasting that suggestion publishes the branch straight onto `main` — no pull request, no review, no CI gate.

Step 3 is why "just read the error" does not save you. The tool proposes the dangerous command.

## Wrong

```bash
git checkout -b fix/thing origin/main          # upstream becomes origin/main
git worktree add ../wt -b fix/thing origin/main
git push origin fix/thing:main
git push origin HEAD:main
```

## Correct

```bash
git checkout --no-track -b fix/thing origin/main
git worktree add --no-track -b fix/thing ../wt origin/main
git push -u origin fix/thing                   # same name both sides
```

To repair a branch that already tracks the wrong thing: `git branch --unset-upstream <branch>`. Check with `git rev-parse --abbrev-ref <branch>@{upstream}` before pushing anything you did not create in this session.

Moving commits onto a branch that is not your own is a pull request, or the branch owner's job. Never a refspec.
