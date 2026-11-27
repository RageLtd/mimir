---
name: less-code
description: Making a change with the least code that does the job, and noticing when the right change removes code or changes nothing. Use whenever you write or change code, before you hand back a change, when you brief someone else to make one, and when you review a diff. For cleanup that must not change behaviour, use the refactor skill.
---

# Less code

Every line you add has to be read, kept true and worked around by whoever
changes the code next. The best change leaves the least behind. Sometimes
that is fewer lines than you started with, or no change at all.

You will not arrive at the smaller change by default. The pull is to add
where removing was the task, to leave old logic running behind a new
condition, and to edit when nothing needed editing. Passing tests catch
none of it, because a test rarely checks that something is absent. Ask the
questions below on purpose.

## Before you add anything

Ask these in order, and stop at the first that settles it.

1. **Does anything need to change?** Confirm the problem in the code as
   it is now: run it, read the path, find the failing case. If the fault
   is not there, the result is a report that says so and shows how you
   checked. That is a finished task. A report with several parts may be
   fixed in one and open in another, so check each part.
2. **Can it be done by removing?** Much unwanted behaviour is code that
   should not be running: a stale special case, a second code path, a
   cache, a flag nobody sets.
3. **Can what is already there do it?** Search before you write: a
   function that exists, a general path that already covers the case, a
   field already on the value in hand.
4. **Then add the specific thing.** Write what this case needs and
   nothing for the next one.

## What the additive answer looks like

Each of these is a way to avoid deciding. When you catch yourself writing
one, ask what you would delete if you were sure.

- **A guard around code that should be gone**: `if (!legacy) { ... }`
  around the old path, or an early return placed before it. The old logic
  still exists and now has a condition to maintain.
- **A catch that turns a failure into a default.**
- **A flag or an option that keeps both behaviours.** One of them is the
  behaviour that was asked for.
- **A parameter added for one caller.**
- **A wrapper that only forwards.**
- **An abstraction with one use**: an interface with one implementation,
  a registry with one entry, a base with one child.
- **The old path kept "for compatibility"** when nothing calls it: an
  alias, a re-export, a deprecated shim.
- **A check on a value your own code produced a few lines earlier.**

## Removing completely

Half a deletion is worse than none, because what remains looks
deliberate.

- **Name the spans first.** List the files and lines that go before you
  edit. If you cannot write the list, you have not finished reading.
- **Take everything that existed only for it**: callers, parameters,
  fields, imports, types, configuration keys, error messages, fixtures,
  documentation and comments. Search for the symbol and for its strings.
- **Take its tests.** A test of behaviour you removed tests nothing. Say
  in your report which tests went and what they covered, because a drop
  in tests is otherwise read as a fault.
- **Leave no remnant.** No commented-out code, no parameter renamed to
  show it is unused, no shim, no comment saying something used to be
  here.
- **Remove what is on the list, all of it, and no more.** Do not stop at
  the first line that makes the test pass.

An abstraction that has grown a conditional for each caller is removed by
inlining it into every caller, keeping in each only what that caller
runs, and deleting the rest. That is a refactor. Do it as its own change,
with the refactor skill.

## Prune before you hand back

Read your own diff one unit at a time: each function, branch, parameter,
option and file you added. For each, ask what fails if it is reverted. If
the answer is nothing, no test and no stated requirement, revert it.
Where you can run the tests, revert the unit and run them. Rereading
alone misses most of what reverting finds.

Then answer two questions in your report:

- Which lines did this change delete?
- Does any logic that was meant to go still run behind a new condition?

## What does not count as less

- **Cramming.** A named value or a small function that shows intent
  stays. More lines are simpler when they are easier to read.
- **Skipping tests or documentation.** Judge each unit by whether it is
  needed, never the diff by its size.
- **Dropping a check that guards a real boundary.** Input from outside
  the program is still validated. A broken contract still fails loudly.
- **Removing what you do not understand.** Find the purpose first: its
  test, its comment, the history, the person who briefed you. If the
  reason cannot be found, say so and ask. Do not delete it quietly, and
  do not keep it quietly either.
- **Widening the change.** Dead code you notice outside the task is a
  line in your report.

## Briefing someone else

Whoever you brief has the same pull toward adding, and knows the code
less well than you do.

- **Name the lines to remove.** "Remove the retry branch in `send`, lines
  40 to 58, and the `maxRetries` option that feeds it" can be done.
  "Simplify the retry handling" will be answered with a new condition.
- **Make the removal the task.** "Stop X happening" invites a guard
  around X. "X no longer needs to exist here; remove it" asks for a
  different change.
- **Say that no change is an acceptable result**, and ask for the
  evidence that goes with it.
- **Do not ask for room to grow.** "Make it extensible" and "in case we
  need it later" ask for the code this skill exists to prevent.

## Reviewing a change

Ask of the diff:

1. Did anything need to change, and does the change say how that was
   established?
2. What did it delete? If nothing, is there truly nothing the new code
   replaces?
3. Does logic that should be gone still run behind a new condition, flag
   or fallback?
4. For each added function, parameter, option and file: which
   requirement or test needs it?
5. Is there an abstraction with one use, or a function that only
   forwards?
6. Is anything handled that cannot occur?
7. Where code was removed, did its callers, configuration, tests and
   documentation go with it, and is any remnant left?
8. Was anything removed whose reason for being there nobody established?
9. Is the smaller version still plain to read?

A "yes" to 3 is a finding even when every test passes.
