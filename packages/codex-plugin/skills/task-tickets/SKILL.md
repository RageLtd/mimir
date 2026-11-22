---
name: task-tickets
description: Principles for writing, updating and reviewing task tickets in any issue tracker, for any team, meaning a ticket for a piece of work that someone has already decided should be done. Use this whenever you file a task, chore, to-do or work item, turn a direct request or instruction into a ticket, or record work the owner of the project asked for. Use it for technical work with no user-visible change, such as a dependency or tooling upgrade, a build, pipeline, deployment or infrastructure change, a migration, a cleanup, documentation, and for a spike or investigation. Use it when someone proposes a ticket for a refactor, which does not get one. Use it when choosing the title, saying what is to be done and why, writing what done means, stating constraints and what is out of scope, and saying how an infrastructure change will be checked and backed out. Use it when breaking work into tasks, and when deciding between one ticket with a checklist and several tickets. Use it after filing too, when the request changes, progress is posted, new work is discovered or the ticket is closed, and when deciding whether a note belongs on the ticket or with the code change. Also use it when reviewing someone else's task or briefing someone to write one. It is about how to think, not about any one tracker's fields.
---

# Task tickets

A task ticket records a piece of work that has been decided on, so that
someone can do it and everyone can tell when it is done. Linear's method
puts the whole idea in one sentence, and everything below follows from it:

> An issue should describe a task with a clear, defined outcome.

## What a task ticket is

- **The what is already decided.** Someone with the say has asked for this
  piece of work. The ticket does not have to discover a need or weigh
  solutions. It has to state the work so it cannot be misread.
- **It has an outcome, not only an activity.** "Look into the build" is an
  activity. "The build finishes in under five minutes on a clean checkout"
  is an outcome.
- **It may change nothing a user can see.** An upgrade, a pipeline change,
  a cleanup and an investigation are all tasks. A refactor is not: see
  below.
- **It is small.** Linear's guidance is to scope issues as small as
  possible, because progress on a large one is hard to see.

If the request describes a need and leaves open what to build, it is a
story. If it reports something broken that was supposed to work, it is a
bug. Do not turn a task into a story by inventing a user for it. Lullabot's
advice is to call a ticket that involves no user what it is: a task for
someone to perform.

## The two ways a task ticket fails you

- **Nobody can tell when it is done.** "Improve logging", "Clean up the
  auth module". The work has no end, so it stops when the worker runs out
  of time or interest, and the person who asked finds out later what they
  got.
- **It says what to do and not why.** The worker follows it to the letter
  and misses the point, or meets a choice the ticket did not foresee and
  has nothing to choose by. Thoughtworks goes further: a technical task
  with no stated value cannot be weighed against other work, so it sinks
  to the bottom of the list or is done when it should not be.

## The title

- **Start with a verb and name the thing.** "Upgrade the database driver to
  version 5", "Move session storage out of the request handler". Mike Cohn
  borrows a form for work with no user: an action, a result and an object,
  as in "Merge the data for duplicate transactions".
- **Say what will be done, not the area.** Lullabot's pair: "Prevent nav
  bar from bouncing on scroll" is a title, "Navigation is wonky" is not.
- **Make it readable in a list.** Linear's reason: most people will only
  ever see the title, on a board, among other titles.

## The body

Three things, in this order. For a small task each is a sentence.

1. **What is to be done.** In plain words, in the terms of whoever asked.
   If the task came from a request, quote the request and say who made it
   and when. Do not widen it: the ticket records what was asked, and
   anything you think should be added is a question for the person who
   asked.
2. **Why.** What is wrong or missing today, and what this makes possible.
   Bill Wake's test for a task is that it can be explained and justified to
   the person paying for it.
3. **Done when.** See below. Every task ticket has this, however small.

Then, only if they apply:

- **Constraints.** What must not change, what must be used, what it must
  stay compatible with.
- **Out of scope.** The nearby thing this task does not include.

Linear's advice is to write only as much as is needed to perform the task.
A task ticket that runs to pages is usually a plan for the work, which
belongs elsewhere, or several tasks.

## Done when

Wake's measure of a task is one question: can we mark it as done? The
ticket answers it in advance.

- **State results, not steps.** "Add retry logic" is a step. "A request
  that fails with a timeout is retried twice, then reported" is a result.
- **Say what the product or system does, not what the code contains.** The
  same rule as for a story's acceptance criteria. "Sign-in still works with
  an expired session cookie", not "the session class has a refresh method".
- **Work with no visible change still has an observable result.** The
  suite passes on the new version and the old one is gone from the lock
  file. Nothing imports the old module. A clean build takes under five
  minutes. The page loads with the service stopped.
- **Everything the ticket does not name stays as it is.** A ticket is a
  scoped piece of work, so this holds for every ticket and is never written
  as a line of its own. If the work turns out to need a change outside the
  scope, that is a decision for whoever asked, recorded on the ticket.
## A refactor does not get a ticket

A refactor changes the structure of the code and preserves its behaviour
completely. That leaves nothing for a ticket to hold: no outcome anyone
outside the code could check, and no done-when except "the same as
before", which every ticket already assumes.

- **Refactor as part of the work that needs it.** Ron Jeffries' argument is
  that a refactoring item on the backlog is always the inferior idea: clean
  the code the next piece of work passes through, and leave the rest.
  Martin Fowler describes refactoring as something done continuously, as
  much a part of programming as writing an `if` statement, and says a team
  doing it well should hardly ever need to plan it.
- **Its record is the commit.** Why the structure changed and what it
  makes easier are notes about the code, and they go with the change.
- **If it seems too big to ride along, ticket what it is for.** Either the
  work it unblocks, with the restructuring done as the first part of that
  work, or the observable problem it removes: "a clean build takes under
  five minutes", "a new payment provider can be added without editing the
  checkout module". Those are tasks with a result someone can check.
  "Refactor the checkout module" is not.

Fowler does leave room for an occasional planned effort on code that has
been in everyone's way. Under this skill that effort is still filed as the
problem it removes, never as the refactor.

## Kinds of task

### An infrastructure or operations change

A change to a running system needs more on the ticket than a change to
code, because the people affected must be able to read it before it
happens. AWS's guidance and GitLab's rollout plans ask for the same four
things:

- **The expected result**, and what it could affect besides its target.
- **How to check it worked**: the command, the page, the number to watch,
  and for how long.
- **How to back it out**, or fix forward, written down before the change is
  made. Say up to what point backing out is still possible. A data
  migration often cannot be undone by reverting the code.
- **The steps, when their order matters.** Here the procedure is part of
  the requirement, and it belongs on the ticket.

Make the change smaller if the back-out is frightening. AWS's reason is
that a smaller change takes less time to recover from.

### An upgrade, cleanup or other chore

Say why now: what stops working, stops being supported, or gets cheaper.
State the end condition precisely. "Upgrade dependencies" never ends.
"Every package with a known vulnerability is on a fixed version, and the
audit command reports none" does.

### A spike or investigation

A spike buys knowledge, not a change. Cohn's definition is a research
activity that lets a team decide something.

- **The done-when is a list of questions to answer.** Humanizing Work's
  rule: do just enough to answer them and stop. The questions are the
  limit, so write them narrowly.
- **The result is an answer and what follows from it.** A decision, a
  recommendation, or the tickets for the work it revealed. Put the answer
  on the ticket, in a few sentences. Put the evidence where it will be
  kept, and link it.
- **Use one only for uncertainty that blocks a decision.** Cohn's caution
  is that spikes are overused: ordinary uncertainty is resolved by doing
  the work.

## Breaking work into tasks

- **Split by what can be finished alone.** Shape Up's rule is to organise
  by the structure of the work, not by person or role. A list per role
  produces tasks that are all complete while nothing works yet. A piece is
  a good task when it can be finished, checked and shown without the
  others.
- **Do not file the steps of one change.** "Write the code", "write the
  tests", "update the docs" are one task. They are finished together or
  not at all.
- **File what you know, not what you imagine.** Shape Up separates imagined
  tasks, thought up before starting, from discovered tasks, found by doing
  the work, and trusts the second kind. Ticket the first clear pieces and
  add the rest as they are found.
- **A checklist or separate tickets?** Separate tickets when the pieces can
  be done by different people, reviewed apart, or left for later. A
  checklist on one ticket when they are done in one sitting by one worker.
- **Link each piece to what it came from**, so the whole can be seen.

## After it is filed

- **The description is the current request.** When the person who asked
  changes their mind, edit the description and say in a comment what
  changed and that they asked for it.
- **Do not let the task grow.** Work discovered on the way gets its own
  ticket, linked. If it must be done first, say that the task is blocked on
  it.
- **A progress note says what is now true.** What is done, what is left,
  what it is waiting on. Linear's measure of progress is actual work: point
  to the change, not to effort.
- **Close against the done-when.** Say that each line holds and how it was
  checked, and link the change. If the task was dropped, say why in one
  sentence a stranger would accept.

## What does not belong on the ticket

The pull on a task ticket is to make it the plan for the work: the files to
touch, the functions to add, the order to do it in, and then a log of how it
went. The ticket names the outcome. The route belongs to whoever does the
work, and the record of the route belongs with the change.

| The note | Where it goes |
| --- | --- |
| What was asked, why, what done means, constraints, how it ended | The ticket |
| How to check and back out a change to a running system | The ticket |
| Why the change is built this way, what else was considered, how it was tested | The commit message or the pull request description |
| Something a future reader of the code must know and that stays true | A comment in the code, or the documentation in the repository |
| A decision that shapes the structure of the system | A decision record in the repository |
| Which files and functions to touch, and what was tried | Your own working notes, or nowhere |

Google asks that a change description carry what was changed and why,
including decisions not visible in the source. Lullabot's split is business
discussion in the tracker and technical discussion in the review tool.
Simon Willison takes the other side and keeps his whole working record in
the issue thread, which he calls controversial himself. A question settles
most cases:

> Would someone who will never read the code need this?

If yes, it goes on the ticket, in their terms. If no, it goes with the
change.

## Reviewing a task ticket

Ask of each ticket:

1. Does the title start with a verb and name the thing?
2. Does it say what was asked, and is that what was asked and no more?
3. Does it say why?
4. Is there a done-when, and is every line of it a result someone could
   check?
5. Is it a refactor under another name, with nothing to check but "works
   as before"?
6. For a change to a running system, does it say how to check it and how
   to back it out?
7. For a spike, are the questions written down?
8. Could it be finished and shown without another ticket being finished
   first, and if not, is that link recorded?
9. Can it be understood without the author's session and without reading
   the comments?
10. Is there anything on it that belongs with the code change instead?

A "no" to 4 means the ticket is not ready to be worked on. A "yes" to 5
means the ticket should not exist.

## Sources

Read in November 2026. Check the current pages before quoting them.

- Linear, "Write issues not user stories" and "Principles & Practices"
  (the guiding sentence; plain tasks in plain language; titles that scan;
  write only what is needed; quote the request; scope issues small;
  measure progress with actual work).
- Bill Wake, "INVEST in Good Stories, and SMART Tasks" (measurable as "can
  we mark it as done?"; relevant as explainable and justifiable).
- Mike Cohn, "Not Everything Needs to Be a User Story" (a form for work
  with no user) and "Agile Spikes Deliver Knowledge So Teams Can Deliver
  Products" (what a spike is; only for excess uncertainty).
- Lullabot, "Not Everything is a User Story" and "Guidelines for Writing
  Proper Tickets and Commits" (a task is a task; imperative statements;
  titles; business discussion in the tracker, technical in review).
- Ron Jeffries, "Refactoring – Not on the Backlog!", and Martin Fowler,
  "Opportunistic Refactoring" (refactoring does not belong on the backlog;
  refactor as part of the work that needs it; the occasional planned
  effort).
- Thoughtworks, "There is no such thing as a 'tech task'" (technical work
  is weighed by the same measure as everything else, so it must state its
  value).
- Ryan Singer, *Shape Up*, "Map the Scopes" (organise by structure, not by
  person; imagined and discovered tasks; pieces that can be finished
  independently).
- Humanizing Work, "The Humanizing Work Guide to Splitting User Stories"
  (a spike's acceptance criteria are the questions to answer).
- AWS Well-Architected Framework, "Plan for unsuccessful changes", and
  GitLab Handbook, "Rollout Plan Process for Development" (expected result,
  how to validate, risks, a rollback plan written before the change;
  smaller changes recover faster).
- Google, "Writing good CL descriptions"; Simon Willison, "The Perfect
  Commit" (where the reasoning behind a change is recorded, and the
  opposing view).
