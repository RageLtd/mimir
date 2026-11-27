---
name: task-tickets
description: Load this skill before doing any work on a task ticket, a chore or any ticket for work already decided on, ahead of drafting it. Writing, updating and reviewing tickets for work someone has already decided should be done, including upgrades, pipeline and infrastructure changes, migrations, cleanups and spikes. Use whenever you file one, turn a direct request into a ticket, break work into tasks, or update or close one. A refactor does not get a ticket.
---

# Task tickets

A task ticket records a piece of work that has been decided on, so that
someone can do it and everyone can tell when it is done. It describes a task
with a clear, defined outcome.

## What a task ticket is

- **The what is already decided.** The ticket does not have to discover a
  need or weigh solutions. It has to state the work so it cannot be misread.
- **It has an outcome, not only an activity.** "Look into the build" is an
  activity. "The build finishes in under five minutes on a clean checkout"
  is an outcome.
- **It may change nothing a user can see.** An upgrade, a pipeline change,
  a cleanup and an investigation are all tasks. A refactor is not: see
  below.
- **It is small.** Progress on a large one is hard to see.

If the request describes a need and leaves open what to build, it is a
story. If it reports something broken that was supposed to work, it is a
bug. Do not turn a task into a story by inventing a user for it.

## The two ways a task ticket fails you

- **Nobody can tell when it is done.** "Improve logging", "Clean up the
  auth module". The work has no end, so it stops when the worker runs out
  of time or interest.
- **It says what to do and not why.** The worker follows it to the letter
  and misses the point, or meets a choice the ticket did not foresee and
  has nothing to choose by. Without a stated value it also cannot be weighed
  against other work.

## The title

- **Start with a verb and name the thing.** "Upgrade the database driver to
  version 5", "Move session storage out of the request handler".
- **Say what will be done, not the area.** "Prevent nav bar from bouncing on
  scroll" is a title, "Navigation is wonky" is not.
- **Make it readable in a list.**

## The body

Three things, in this order. For a small task each is a sentence.

1. **What is to be done.** In plain words, in the terms of whoever asked.
   If the task came from a request, quote the request and say who made it
   and when. Do not widen it: anything you think should be added is a
   question for the person who asked.
2. **Why.** What is wrong or missing today, and what this makes possible.
3. **Done when.** See below. Every task ticket has this, however small.

Then, only if they apply:

- **Constraints.** What must not change, what must be used, what it must
  stay compatible with.
- **Out of scope.** The nearby thing this task does not include.

Write only as much as is needed to perform the task. A task ticket that runs
to pages is usually a plan for the work, which belongs elsewhere, or several
tasks.

## Done when

- **State results, not steps.** "Add retry logic" is a step. "A request
  that fails with a timeout is retried twice, then reported" is a result.
- **Say what the product or system does, not what the code contains.**
  "Sign-in still works with an expired session cookie", not "the session
  class has a refresh method".
- **Work with no visible change still has an observable result.** The
  suite passes on the new version and the old one is gone from the lock
  file. Nothing imports the old module. A clean build takes under five
  minutes.
- **Everything the ticket does not name stays as it is.** If the work turns
  out to need a change outside the scope, that is a decision for whoever
  asked, recorded on the ticket.

## A refactor does not get a ticket

A refactor changes the structure of the code and preserves its behaviour
completely. That leaves nothing for a ticket to hold: no outcome anyone
outside the code could check, and no done-when except "the same as before".

- **Refactor as part of the work that needs it.** Clean the code the next
  piece of work passes through, and leave the rest.
- **Its record is the commit.**
- **If it seems too big to ride along, ticket what it is for.** Either the
  work it unblocks, with the restructuring done as the first part of that
  work, or the observable problem it removes: "a clean build takes under
  five minutes", "a new payment provider can be added without editing the
  checkout module". "Refactor the checkout module" is not a task.

## Kinds of task

### An infrastructure or operations change

A change to a running system needs more on the ticket, because the people
affected must be able to read it before it happens.

- **The expected result**, and what it could affect besides its target.
- **How to check it worked**: the command, the page, the number to watch,
  and for how long.
- **How to back it out**, or fix forward, written down before the change is
  made. Say up to what point backing out is still possible. A data
  migration often cannot be undone by reverting the code.
- **The steps, when their order matters.** Here the procedure is part of
  the requirement.

Make the change smaller if the back-out is frightening.

### An upgrade, cleanup or other chore

Say why now: what stops working, stops being supported, or gets cheaper.
State the end condition precisely. "Upgrade dependencies" never ends.
"Every package with a known vulnerability is on a fixed version, and the
audit command reports none" does.

### A spike or investigation

A spike buys knowledge, not a change.

- **The done-when is a list of questions to answer.** Do just enough to
  answer them and stop, so write them narrowly.
- **The result is an answer and what follows from it.** A decision, a
  recommendation, or the tickets for the work it revealed. Put the answer
  on the ticket, in a few sentences, and link the evidence.
- **Use one only for uncertainty that blocks a decision.** Ordinary
  uncertainty is resolved by doing the work.

## Breaking work into tasks

- **Split by what can be finished alone**, not by person or role. A piece is
  a good task when it can be finished, checked and shown without the others.
- **Do not file the steps of one change.** "Write the code", "write the
  tests", "update the docs" are one task.
- **File what you know, not what you imagine.** Ticket the first clear
  pieces and add the rest as they are found.
- **A checklist or separate tickets?** Separate tickets when the pieces can
  be done by different people, reviewed apart, or left for later. A
  checklist on one ticket when they are done in one sitting by one worker.
- **Link each piece to what it came from.**

## After it is filed

- **The description is the current request.** When the person who asked
  changes their mind, edit the description and say in a comment what
  changed and that they asked for it.
- **Do not let the task grow.** Work discovered on the way gets its own
  ticket, linked. If it must be done first, say that the task is blocked on
  it.
- **A progress note says what is now true.** What is done, what is left,
  what it is waiting on. Point to the change, not to effort.
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

A question settles most cases:

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
