---
description: Refactor code to make it smaller and simpler without changing what it does — the moves, the order to cut in, and what does not count as simpler. Use when asked to refactor, simplify, clean up or reduce code.
---

You are refactoring: making code smaller and simpler while it behaves exactly as it did. Less code is the deliverable. Removing complexity pays now, not someday, and every layer of abstraction is one more thing the next reader has to know.

The project's own rules still apply. Where one of them is stricter than anything here, the rule wins.

## Before you cut

1. Read the whole file and its callers. Search for every symbol you mean to remove: Cartographer for dependents, a text search for strings and config keys.
2. Check that a test holds the behaviour you are about to move. If none does, say so before changing anything; a refactor with no test to hold it is a rewrite.

## Cut in this order

1. Dead code.
2. Wrappers that only forward.
3. Helpers with a single caller.
4. Duplicated blocks.
5. Comments that narrate what the code already says.

## The moves

1. **Inline single-use functions.** A function called from one place usually reads better in that place, top to bottom, with its steps visible.
2. **Compress on the second use, never the first.** Reuse nothing until two real instances exist, then pull out only what the copies share.
3. **Delete wrappers that only forward.** A function whose body is one call with the same arguments is a second name for the same thing.
4. **Prefer one general path over many special cases.** The large wins come from a simpler, more general approach, not from tuning each case.
5. **Shrink the area under ifs.** Where it is cheap and safe, do the work unconditionally and discard the result rather than branching around it. Fewer paths, fewer bugs.
6. **Move toward pure functions.** Gather the inputs, call a function that only reads its parameters, apply the result. A step toward purity improves the code even when it does not get all the way.
7. **Make things constant.** Anything that does not need to change should not be able to.
8. **Treat a long parameter list as a smell.** Restructure the data instead of passing a dozen things.
9. **Group repeated locals into one value, then repeated operations into functions over it.** In that order.

## What does not count as simpler

- Fewer lines from cramming: nested ternaries, side effects inside conditions, work hidden in assertions.
- Dropping checks. A contract violation must still fail loudly.
- A generic layer or a flag that merges two cases which only look alike.
- A rename or a moved file with the same amount of logic.

## Keep the behaviour

- Same outputs, same errors, same order of side effects.
- Build and run the tests. A test that fails afterwards means the refactor changed behaviour until proven otherwise.
- Delete a test only when it checks nothing real: a getter, a constant, a duplicate of another test.

## Report

Say what you removed and why it was safe, the line count before and after, and anything you left alone on purpose.

$ARGUMENTS
