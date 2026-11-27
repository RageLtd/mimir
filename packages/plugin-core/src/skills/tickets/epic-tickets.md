---
name: epic-tickets
description: Load this skill before doing any work on an epic, a project or a breakdown of work into tickets, ahead of drafting it. Writing, updating and reviewing tickets that hold a body of work, whatever the tracker calls them (epic, project, initiative, milestone, parent issue). Use whenever you create one, break a feature or goal down into tickets, write a status update, cut or add scope, or close one.
---

# Epic tickets

An epic holds a body of work that is too large for one ticket and still has
an end.

## What an epic is

- **One goal, reached through several tickets.**
- **It has an end.** There is a state of the product in which the epic is
  finished, and it can be described before the work starts.
- **It is the top of a small tree.** Its children are stories, tasks and
  bugs, each written to its own skill. The epic says what they add up to.
- **Its name depends on the tracker.** Use the tracker's word and keep the
  idea.

It is not a category. "Reporting" or "Performance" groups tickets that
share a subject and never finishes: that is a label. It is not a place to
park ideas either.

## The two ways an epic fails you

- **It never ends.** It began as a goal and became a bucket: new tickets
  are added as fast as old ones close.
- **Its tickets close and nothing works.** The work was divided by layer or
  by person, every piece is complete, and the pieces only meet at the end.
  Or the count of closed tickets rises while the hard question stays
  unanswered.

## The title

Name the result, so a reader of a roadmap knows what will exist. "Invoices
can be exported and emailed", "Offline mode for the mobile app". Not the
subject ("Invoice improvements") and not the activity ("Invoice work, phase
2").

## The body

In this order. Most of it is short.

1. **The goal, and why now.** The problem, for whom, and what they do
   today without this, with one specific case that shows why the present
   state does not work.
2. **What done means for the whole.** A few statements of what the product
   does when the epic is finished, written the same way as a story's
   acceptance criteria. Where the work has stages, give each stage its own
   definition: done for a closed beta is not done for a public release.
3. **The shape of the solution, if one is agreed.** The main elements in a
   few lines, and a link to the design document that holds the rest.
4. **What is left out.** Not a negated goal, but something that could
   reasonably have been a goal and was chosen not to be.
5. **Known risks and open questions.** The parts nobody yet knows how to
   do, named before work starts.
6. **The children**, linked, in the order they will be done.

Everything the epic does not name stays as it is.

## Where the design lives

The epic says what and why, within what bounds. How the system will be
built, and the trade-offs behind it, go in a design document. Keep that
document with the code where the tools allow, link it from the epic, and put
on the epic only the decisions a reader of the epic needs: what was chosen,
and what it rules in or out.

## Breaking it down

- **See the whole before cutting it.** Lay the work out as what the user
  does, in the order they do it, with the detail of each step beneath it. A
  flat list of tickets loses that shape, and with it the ability to see what
  is missing.
- **Cut along what can be finished alone**, not by person or role. Each
  piece cuts through every layer it needs, and can be finished, checked and
  shown without the others. A list for "backend" and a list for "frontend"
  produces tasks that are all done while nothing can be tried.
- **First, the thinnest thing that works end to end.** Everything after it
  improves something that already runs.
- **Then the piece that teaches the most**: core to the idea, small, and new
  to the people building it. An unknown found late can change everything
  built before it.
- **Mark what could be cut.** Separate the must-haves from the
  nice-to-haves when the tickets are written.
- **Write only the near tickets in full.** Give the next pieces full
  tickets, and the later ones a line each.
- **Each child stands alone.** It has its own title, reason and done-when,
  and can be understood without opening the epic. It links back.

The steps a user takes are good seams: "choose a plan", then "pay", then
"get a receipt". The steps a builder takes are not: "schema", "API",
"screen".

Two questions check a breakdown:

> If every child were closed, would the goal be met?
>
> Does every child serve the goal?

A "no" to the first means a ticket is missing. A "no" to the second means a
ticket belongs somewhere else.

If the pieces fall into groups that could each be finished and shipped
without the others, it is several epics. Split it, and give each its own
goal and definition of done.

## After it is filed

- **The description is the current plan.** When scope or design changes,
  edit the description and say in a comment what changed and who decided.
- **Post a status update when the state of the whole changes.** A piece is
  finished, a question is answered, a risk appears, work stops or starts
  again. Each update says where the epic stands, what changed since the last
  one, and what comes next or is worrying. It is written for someone who is
  not doing the work.
- **Report what is unknown, not how many tickets are closed.** Say which
  pieces are still being figured out and which only need doing. "We do not
  yet know how to do the sync, and that is the risk" is a good update.
- **Progress on a piece goes on that piece.** The epic's update sums up.
- **Cut scope against the baseline, not the ideal.** Is what exists already
  better than what people have today? Record each cut on the epic, with
  where it went: a later epic, a ticket in the backlog, or nowhere.
- **Adding scope is a decision, with a name on it.** New work found on the
  way either serves the goal or belongs elsewhere.
- **Say when it is parked**, with what is finished and what the next step
  would be, so it can be picked up cold.

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

A question settles most cases:

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
