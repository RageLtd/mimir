---
name: less-code
description: Principles for making a change with the least code that does the job, in any language, and for noticing when the right change removes code or changes nothing. Use this whenever you write or change code, meaning when you fix a bug, add a feature, handle an error or an edge case, or act on review findings. Use it when you are about to add a guard, a fallback, a flag, an option, a parameter, a wrapper, a helper, a layer, an abstraction or a dependency, and when a fix could be made by taking code out instead. Use it when a bug report may be stale or already fixed and the honest result is no change. Use it when you delete a feature, a branch or a code path and need to take everything that existed only for it. Use it before you hand back a change, to prune what the change does not need, when briefing someone else to make a change that should remove something, and when reviewing a diff for code that did not need to be written or that should have been deleted. For cleanup that must not change behaviour, use the refactor skill. It is about how to think, not about any one language.
---

# Less code

Code is a cost. Dijkstra put it as bookkeeping:

> if we wish to count lines of code, we should not regard them as "lines
> produced" but as "lines spent"

Every line you add has to be read, kept true and worked around by whoever
changes the code next. The best change is the one that leaves the least
behind, and sometimes that is fewer lines than you started with, or no
change at all.

## The pull is toward adding

You will not arrive at the smaller change by default. That has been
measured.

- **Models add where removing was the task.** Santagata and De Nobili gave
  language models a choice between adding and removing, and on a task to
  make a string a palindrome one model added letters 97.85% of the time.
  The size of the effect changed with the task and the model.
- **A passing patch often keeps what should have gone.** Ebrahimi and
  others compared model patches with the developers' own on tasks the
  models solved. The models edited the file that held a required deletion
  more than 92% of the time and removed the exact line about half the
  time. In 29% of the passing patches, the logic the developer had removed
  was still there, with execution routed around it by a new condition or
  fallback. The paper calls this Guard-and-Go.
- **The tests do not notice.** A test rarely checks that something is
  absent. When the same paper added such checks to deletion-heavy tasks,
  passing attempts fell from 63.2% to 41.9%.
- **Models edit when nothing needed editing.** Gloaguen and others built
  tasks where the reported problem was already fixed. Models proposed
  unwanted code changes in 35 to 65% of them.

So "the tests pass" and "this feels finished" tell you little here. The
questions below have to be asked on purpose.

## Before you add anything

Ask these in order, and stop at the first that settles it.

1. **Does anything need to change?** Confirm the problem in the code as
   it is now: run it, read the path, find the failing case. If the fault
   is not there, the result is a report that says so and shows how you
   checked. That is a finished task and not a failure to deliver.
   Gloaguen's caution applies: a report with several parts may be fixed
   in one and open in another, so check each part.
2. **Can it be done by removing?** Much unwanted behaviour is code that
   should not be running: a stale special case, a second code path, a
   cache, a flag nobody sets. Ousterhout's advice on error handling is
   the same move: "The best way to eliminate exception handling
   complexity is to define your APIs so that there are no exceptions to
   handle."
3. **Can what is already there do it?** Search before you write. A
   function that exists, a general path that already covers the case, a
   field already on the value in hand.
4. **Then add, and add the specific thing.** Write what this case needs
   and nothing for the next one. Muratori: "make your code usable before
   you try to make it reusable", and reuse nothing until there are two
   real instances. Fowler prices the alternative. A feature built ahead
   of need costs its build, the delay to what was needed, and the weight
   it adds to every later change. His rule: "any abstraction that makes
   it harder to understand the code for current requirements is presumed
   guilty."

## What the additive answer looks like

Each of these is a way to avoid deciding. When you catch yourself writing
one, ask what you would delete if you were sure.

- **A guard around code that should be gone.** `if (!legacy) { ... }`
  around the old path, or an early return placed before it. The old
  logic still exists and now has a condition to maintain.
- **A fallback for a case that cannot happen**, or a catch that turns a
  failure into a default. Muratori on structure added for safety: "it is
  not worth trying to 'prevent mistakes' if you are also preventing
  good, maintainable code!"
- **A flag or an option that keeps both behaviours.** One of them is the
  behaviour that was asked for.
- **A parameter added for one caller.** Metz describes where this ends:
  a parameter, then a conditional, then another, until the function no
  longer stands for any one idea.
- **A wrapper that only forwards.** Ousterhout's red flag: "a method
  does almost nothing except pass its arguments to another method with a
  similar signature."
- **An abstraction with one use**: an interface with one implementation,
  a registry with one entry, a base with one child.
- **The old path kept "for compatibility"** when nothing calls it: an
  alias, a re-export, a deprecated shim.
- **A dependency for one function.** Pike: "A little copying is better
  than a little dependency."
- **A check on a value your own code produced a few lines earlier.**

## Removing completely

Half a deletion is worse than none, because what remains looks
deliberate.

- **Name the spans first.** List the files and lines that go before you
  edit. In Ebrahimi's experiments an instruction to delete instead of
  working around changed success by two and a half points either way,
  and being given the exact lines was the one thing that helped every
  model. If you cannot write the list, you have not finished reading.
- **Take everything that existed only for it**: callers, parameters,
  fields, imports, types, configuration keys, error messages, fixtures,
  documentation and comments. Search for the symbol and for its strings.
- **Take its tests.** A test of behaviour you removed tests nothing.
  Say in your report which tests went and what they covered, because a
  drop in tests is otherwise read as a fault.
- **Leave no remnant.** No commented-out code, no parameter renamed to
  show it is unused, no shim, no comment saying something used to be
  here. The history holds the old version.
- **Do not stop at the first line that makes the test pass.** The same
  experiments found incomplete deletion to be the commonest failure, and
  that a model handed the exact lines sometimes removed more than them.
  Remove what is on the list, all of it, and no more.

When the thing to remove is an abstraction that has grown a conditional
for each caller, Metz gives the way back: inline it into every caller,
keep in each only what that caller runs, and delete the rest. That is a
refactor. Do it as its own change, with the refactor skill, and not
folded into a fix.

## Prune before you hand back

Read your own diff one unit at a time: each function, branch, parameter,
option and file you added. For each, ask what fails if it is reverted.
If the answer is nothing, no test and no stated requirement, revert it.

Goel and others did this mechanically to agent patches, reverting each
unit and running the tests again. About one code unit in nine turned out
to be unneeded. Asking the agent to audit its own diff found roughly a
third of them, and reverting and re-running found about two thirds. So
where you can run the tests, revert and run them. Do not only reread.

Then answer two questions in your report, plainly:

- Which lines did this change delete?
- Does any logic that was meant to go still run behind a new condition?

## What does not count as less

Less code is a means. Muratori on every rule of this kind: they are
"just concepts and guidelines that someone made up on the way to
achieving a lower total cost for code", and the total cost is what you
are judging. These are the ways the rule gets misapplied.

- **Cramming.** Beck's rules of simple design end with "fewest
  elements", and it comes last: a named value or a small function that
  shows intent stays. Where the rules pull apart, Beck's answer is that
  "empathy wins over some strictly technical metric." Ousterhout:
  "Sometimes an approach that requires more lines of code is actually
  simpler, because it reduces cognitive load."
- **Skipping the tests.** Goel's study found that agent patches are
  larger than developers' mostly because of tests and documentation, and
  that the code in them was about as necessary as the developers' own.
  Judge each unit by whether it is needed, never the diff by its size.
  Fowler says the same of his own rule: it does not apply to work that
  makes the software easier to change, such as tests and refactoring.
- **Dropping a check that guards a real boundary.** Input from outside
  the program is still validated. A broken contract still fails loudly.
- **Removing what you do not understand.** This one is not drawn from
  the sources. Before you delete code whose purpose is unclear, find the
  purpose: its test, its comment, the history if you can read it, the
  person who briefed you. The burden is on whoever removes. If the
  reason cannot be found, say so and ask. Do not delete it quietly, and
  do not keep it quietly either.
- **Widening the change.** Dead code you notice outside the task is a
  line in your report. Google's review guide asks that cleanup usually
  go in a separate change from a fix or a feature, so that each can be
  read for what it is.

## Briefing someone else

The person or agent you brief has the same pull toward adding and less
knowledge of the code than you.

- **Name the lines to remove.** You have read the code. "Remove the
  retry branch in `send`, lines 40 to 58, and the `maxRetries` option
  that feeds it" can be done. "Simplify the retry handling" will be
  answered with a new condition.
- **Make the removal the task.** "Stop X happening" invites a guard
  around X. "X no longer needs to exist here; remove it" asks for a
  different change.
- **Say that no change is an acceptable result.** Gloaguen and others:
  "inaction needs to be explicitly framed as a path to success." Ask for
  the evidence that goes with it.
- **Do not ask for room to grow.** "Make it extensible" and "in case we
  need it later" are requests for the code this skill exists to prevent.

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

A "yes" to 3 is a finding even when every test passes. That is the case
the tests were shown not to catch.

## Sources

Read in November 2026. Check the current pages before quoting them.

- Edsger W. Dijkstra, "On the cruelty of really teaching computing
  science", EWD1036, 1988 (lines of code as lines spent).
- Luca Santagata and Cristiano De Nobili, "More is More: Addition Bias
  in Large Language Models", 2024 (models choose to add; the effect
  varies by task and model). It replicates part of Adams and others,
  "People systematically overlook subtractive changes", Nature, 2021,
  which could not be opened and is known here only as that paper
  describes it.
- Amir M. Ebrahimi and others, "To Add Is Machine, To Delete Is Human:
  Measuring and Mitigating Deletion Avoidance in LLM Code Editing", 2026
  (deletions left in place by passing patches; Guard-and-Go; checks for
  absence; instruction against exact lines; incomplete deletion and
  over-deletion). Some of its figures were read through a summary of a
  truncated page.
- Thibaud Gloaguen and others, "Coding Agents Don't Know When to Act",
  2026 (tasks that need no change; abstaining on a partly fixed issue;
  inaction as a path to success).
- Aakash Goel, Benjamin Steenhoek and Yu Hu, "How Much Do Coding Agents
  Over-Edit, and Why?", 2026 (unneeded units found by reverting and
  re-running; self-audit against pruning; extra volume is mostly tests
  and documentation).
- Casey Muratori, "Semantic Compression", "Complexity and Granularity"
  and "Defining a Single Enumerant", 2014 (usable before reusable; two
  instances before reuse; total cost as the only measure; structure
  added to prevent mistakes).
- John Ousterhout, *A Philosophy of Software Design*, first edition,
  2018 (define errors out of existence; pass-through methods and the
  summary of red flags; more lines can be simpler).
- Martin Fowler, "Beck Design Rules", 2015 (Kent Beck's four rules,
  fewest elements last; empathy over a technical metric) and "Yagni",
  2015 (the costs of a feature built ahead of need; abstractions
  presumed guilty; the rule does not cover tests and refactoring).
- Sandi Metz, "The Wrong Abstraction", 2016 (how a shared function
  gathers parameters and conditionals; inlining it back into its
  callers).
- Rob Pike, "Go Proverbs", Gopherfest 2015, as transcribed by Chris
  Lesiw (a little copying against a little dependency).
- Google, "Small CLs", engineering practices documentation (cleanup
  usually separate from a fix or a feature).
