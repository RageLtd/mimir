---
name: epic-tickets
description: Principles for writing, updating and reviewing tickets that hold a body of work, in any issue tracker, for any team, whatever the tracker calls them, such as an epic, project, initiative, milestone, parent issue or tracking issue. Use this whenever you create one, plan a piece of work too large for a single ticket, or are asked to break a feature, project or goal down into tickets. Use it when stating the goal, saying what done means for the whole, listing what is deliberately left out, and deciding what belongs in the epic and what belongs in a design document. Use it when deciding how to slice the work, what to build first, how far ahead to write the child tickets, and whether a group of tickets is one epic, several, or only a category. Use it after filing too, when you write a status update, record a decision, cut or add scope, or close the epic, and when deciding whether a note belongs on the epic, on a child ticket or with the code. Also use it when reviewing someone else's epic or breakdown, or briefing someone to write one. It is about how to think, not about any one tracker's hierarchy or any one planning method.
---

# Epic tickets

An epic holds a body of work that is too large for one ticket and still has
an end. Linear's team puts the whole idea in two short sentences, and
everything below follows from them:

> Issues want to be done. Projects want to be done.

## What an epic is

- **One goal, reached through several tickets.** Mike Cohn's definition is
  simply a story too big to finish in one go.
- **It has an end.** There is a state of the product in which the epic is
  finished, and it can be described before the work starts.
- **It is the top of a small tree.** Its children are stories, tasks and
  bugs, each written to its own skill. The epic says what they add up to.
- **Its name depends on the tracker.** Epic, project, milestone, parent
  issue. Cohn's advice is not to fight the tool: use the tracker's word and
  keep the idea.

It is not a category. "Reporting" or "Performance" groups tickets that
share a subject and never finishes: that is a label, or what Cohn calls a
theme. It is not a place to park ideas either. Shape Up's answer to a raw
idea is "interesting, maybe some day", and no ticket.

## The two ways an epic fails you

- **It never ends.** It began as a goal and became a bucket: new tickets
  are added as fast as old ones close. GitLab's handbook warns of epics
  that drag on indefinitely, and Shape Up calls the cause a grab-bag,
  several unrelated things under one name.
- **Its tickets close and nothing works.** The work was divided by layer or
  by person, every piece is complete, and the pieces only meet at the end.
  Or the count of closed tickets rises while the hard question stays
  unanswered, and nobody reading the epic can tell.

## The title

Name the result, so a reader of a roadmap knows what will exist. "Invoices
can be exported and emailed", "Offline mode for the mobile app". Not the
subject ("Invoice improvements") and not the activity ("Invoice work, phase
2").

## The body

In this order. Most of it is short.

1. **The goal, and why now.** The problem, for whom, and what they do
   today without this. Shape Up asks for one specific story that shows why
   the present state does not work. Linear's team calls the purpose of a
   project write-up situational awareness: in what context this was a good
   idea.
2. **What done means for the whole.** A few statements of what the product
   does when the epic is finished, written as functionality, the same way
   as a story's acceptance criteria. Where the work has stages, give each
   stage its own definition. Linear uses milestones for exactly this: done
   for a closed beta is not done for a public release.
3. **The shape of the solution, if one is agreed.** The main elements in a
   few lines, and a link to the specification or design document that holds
   the rest.
4. **What is left out.** Malte Ubl's definition of a non-goal is the useful
   one: not a negated goal, but something that could reasonably have been a
   goal and was chosen not to be.
5. **Known risks and open questions.** The parts nobody yet knows how to
   do. Shape Up calls them rabbit holes and wants them named before work
   starts.
6. **The children**, linked, in the order they will be done.

Everything the epic does not name stays as it is. That holds for every
ticket and is never written as a line of its own.

## Where the design lives

The epic says what and why, within what bounds. How the system will be
built, and the trade-offs behind it, go in a design document. Google's
practice, as Ubl describes it, is that the design document is the place for
the trade-offs and the alternatives considered. Linear's team writes a
short specification of one or two pages with the key product and technical
decisions. Keep that document with the code where the tools allow, link it
from the epic, and put on the epic only the decisions a reader of the epic
needs: what was chosen, and what it rules in or out.

## Breaking it down

This is most of the work of an epic, and where most of them go wrong.

- **See the whole before cutting it.** Jeff Patton lays the work out as a
  map: what the user does, in the order they do it, left to right, with the
  detail of each step beneath it. A flat list of tickets loses that shape,
  and with it the ability to see what is missing.
- **Cut along what can be finished alone.** Shape Up's rule is to organise
  by the structure of the problem, not by person or role. Each piece cuts
  through every layer it needs, and can be finished, checked and shown
  without the others. A list for "backend" and a list for "frontend"
  produces tasks that are all done while nothing can be tried.
- **First, the thinnest thing that works end to end.** Patton takes the top
  item under each step of the map and builds that first: the walking
  skeleton, Alistair Cockburn's term, which Patton describes as the
  smallest possible system that gives end-to-end functionality. Everything
  after it improves something that already runs.
- **Then the piece that teaches the most.** Shape Up's test for what to
  start with: it is core to the idea, small, and new to the people
  building it. Push the parts with unknowns forward, and leave the routine
  parts for later, because an unknown found late can change everything
  built before it.
- **Mark what could be cut.** Separate the must-haves from the
  nice-to-haves when the tickets are written, so it is clear what the goal
  can do without.
- **Write only the near tickets in full.** GitLab's guidance is not to
  break work down far ahead of doing it. Shape Up's reason is that tasks
  imagined before the work starts are worse than tasks discovered by doing
  it. Give the next pieces full tickets, and the later ones a line each.
- **Each child stands alone.** It has its own title, reason and done-when,
  and can be understood without opening the epic. It links back.

Authors differ on one point. Atlassian suggests splitting an epic by the
ordered steps of a process, or by user role. Humanizing Work and Shape Up
warn against splitting by step. Both are right about different steps. The
steps a user takes are good seams: "choose a plan", then "pay", then "get a
receipt". The steps a builder takes are not: "schema", "API", "screen".

Two questions check a breakdown:

> If every child were closed, would the goal be met?
>
> Does every child serve the goal?

A "no" to the first means a ticket is missing. A "no" to the second means a
ticket belongs somewhere else. Shape Up allows a short list for loose ends
and treats more than three to five items on it as a sign that a piece has
not been named.

If the pieces fall into groups that could each be finished and shipped
without the others, it is several epics. Split it, and give each its own
goal and definition of done.

## After it is filed

An epic lives longer than any of its tickets, so keeping it true matters
more.

- **The description is the current plan.** When scope or design changes,
  edit the description and say in a comment what changed and who decided.
  A reader should never have to replay the history to learn what the epic
  is today.
- **Post a status update when the state of the whole changes.** A piece is
  finished, a question is answered, a risk appears, work stops or starts
  again. Each update says three things: where the epic stands; what
  changed since the last one; and what comes next or is worrying. It is
  written for someone who is not doing the work. Linear's teams also give
  each update a health mark, which is worth copying where the tracker has
  one.
- **Report what is unknown, not how many tickets are closed.** Shape Up's
  point is that a count of tasks says nothing about the tasks not yet
  discovered. Say which pieces are still being figured out and which only
  need doing. "We do not yet know how to do the sync, and that is the
  risk" is a good update.
- **Progress on a piece goes on that piece.** The epic's update sums up. It
  does not repeat each child's comments.
- **Cut scope against the baseline, not the ideal.** Shape Up's test for
  whether a piece can go: is what exists already better than what people
  have today? Record each cut on the epic, with where it went: a later
  epic, a ticket in the backlog, or nowhere.
- **Adding scope is a decision, with a name on it.** New work found on the
  way either serves the goal or belongs elsewhere.
- **Say when it is parked.** If work on the epic stops for now, write that
  on it, with what is finished and what the next step would be, so it can
  be picked up cold.

## Closing it

- **Close against the definition of done**, not when the tickets run out.
  Say that each statement holds and how it was checked.
- **List what was cut and where it went.**
- **Leave no open children.** Finish them, move them, or close them with a
  reason.
- **Link what shipped**: the release, the documentation, the announcement.
- **Do not reopen it for follow-up work.** That is a new ticket, or a new
  epic.

## What does not belong on the epic

The epic holds the goal, the bounds, the decisions and the state of the
whole. It is tempting to make it the project's notebook, because it is the
one ticket everyone opens.

| The note | Where it goes |
| --- | --- |
| Goal, done, what is left out, decisions and who made them, current status | The epic |
| Progress, questions and results for one piece | That child ticket |
| How the system will be built, the trade-offs, the alternatives considered | A design document, linked from the epic |
| A decision that shapes the structure of the system | A decision record in the repository |
| Why a change is built the way it is, and how it was tested | The commit message or the pull request description |
| What was tried along the way, meeting by meeting or session by session | Your own working notes, or nowhere |

Michael Nygard's reason for keeping decisions as short records beside the
code is that they are then versioned with what they describe. Simon
Willison takes the other side and keeps his whole working record in the
issue thread, which he calls controversial himself. A question settles most
cases:

> Would someone who will never read the code need this?

If yes, it goes on the epic, in their terms. If no, it goes with the design
or the change.

## Reviewing an epic

Ask of each one:

1. Does the title name a result?
2. Can you say what the product does when it is finished, and is that
   written down?
3. Does it say what is left out?
4. Could each child be finished and shown alone?
5. Is there an early child that makes the thing work end to end?
6. If every child were closed, would the goal be met, and does every child
   serve it?
7. Are the unknowns named, and are they early in the order?
8. Does the description match today's plan, and does the last status
   update match the state of the work?
9. Is there anything on it that belongs on a child, in a design document
   or with the code?

A "no" to 2 means it is a category, not an epic. A "no" to 4 means the work
was cut by layer.

## Sources

Read in November 2026. Check the current pages before quoting them.

- Linear, "How we run projects at Linear" (the guiding sentences; projects
  have an end; short specifications and their purpose; status updates
  written by a project lead; milestones as staged definitions of done) and
  the Linear documentation, "Updates" (health as on track, at risk or off
  track, with a written description).
- Ryan Singer, *Shape Up*: "Set Boundaries" (grab-bags; no backlog for raw
  ideas), "Write the Pitch" (problem, solution, rabbit holes, no-gos), "Get
  One Piece Done" (one
  integrated piece early; core, small and novel), "Map the Scopes"
  (organise by structure; imagined and discovered tasks; the loose-ends
  list), "Show Progress" (unknown against solved instead of task counts)
  and "Decide When to Stop" (compare to baseline; must-haves and
  nice-to-haves).
- Jeff Patton, "The New User Story Backlog is a Map" (the map of
  activities and tasks; why a flat backlog loses the picture; the walking
  skeleton first, credited to Alistair Cockburn).
- Mike Cohn, "Epics, Features and User Stories" (an epic is a big story; a
  theme is a group; use the tool's terms).
- Atlassian, "Epics" (a body of work broken into stories; ways to break one
  down).
- GitLab Handbook, "Using GitLab to plan work" (epics that drag on
  indefinitely; do not break work down far ahead; comment when closing).
- Malte Ubl, "Design Docs at Google" (goals and non-goals; the design
  document as the place for trade-offs and alternatives).
- Humanizing Work, "The Humanizing Work Guide to Splitting User Stories"
  (vertical slices; why splitting by layer fails).
- Michael Nygard, "Documenting Architecture Decisions"; Simon Willison,
  "The Perfect Commit" (where decisions and working notes are kept, and the
  opposing view).
