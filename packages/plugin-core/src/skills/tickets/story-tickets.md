---
name: story-tickets
description: Load this skill before doing any work on a story, feature request or enhancement ticket, ahead of drafting it. Writing, updating and reviewing tickets that start from something a user, customer or operator needs and ask for a change they would notice. Use whenever you file a story or feature request, turn a need raised in conversation into a ticket, split one that is too big, or update or close one.
---

# Story tickets

A story ticket asks for a change in what someone can do. It is the record of
an agreement: who wants what, why, and how everyone agreed to tell that it is
done. It does not replace that agreement.

## What a story ticket is

- **It describes a change someone outside the code would notice.** When it
  is done, a user, a customer, an operator or another system can do
  something they could not do before, or do it better.
- **It is a slice through the whole system, not a layer of it.** "Add the
  database column" is a step toward a story.
- **It is small enough to finish and to understand.**
- **It is negotiable until it is built.** It states the need and the
  conditions for done. It leaves the design to whoever builds it.

Something broken that was supposed to work is a bug ticket. Something too
large to finish as one piece is an epic. A piece of work someone has already
decided on, or work no user would notice, is a task. Do not dress a task as a
story: "As a developer, I want…" names someone who builds the system, not
someone who uses it.

## The two ways a story ticket fails you

- **It says what to build and not why.** The builder cannot choose between
  two designs, cannot tell which details matter, and cannot notice that a
  cheaper change would meet the need.
- **Nobody can say when it is done.** It has no end, so it grows, and the
  person who asked and the person who built it find out at the end that
  they meant different things.

## Agree first, then write

- **Do not invent requirements to fill the page.** If nobody has said how an
  edge case should behave, that is an open question. Write it down as one,
  addressed to the person who can answer it.
- **Record what was agreed, and by whom.** A decision with a name and a date
  can be trusted or questioned. An unattributed sentence cannot.
- **Write the detail down.** The ticket is read later by someone who cannot
  ask you.

## The title

- **Name the change in behaviour, in plain words.** "Export an invoice as
  PDF", "Search finds chats by title". Once it is delivered, someone can do
  that thing.
- **Not a solution with no context.** "How much potential cash is in blocked
  projects?" is a good summary and "Cash report" is not.
- **Not a topic.** "Notifications" says nothing about what will be
  different.

## Who and why

- **The "As a … I want … so that …" template is optional.** Use it when it
  helps you think, and write a plain sentence when it does not.
- **Name a real person or role.** Check that they exist and that they want
  this. "As a user" and "As the system" usually mean nobody was asked.
- **The why is what the builder designs from.** "I want a spell checker"
  produces a tool you run afterwards. Adding "so that I don't have to worry
  about spelling mistakes" produces correction as you type.
- **Say when it matters, if the trigger explains more than the role**: "When
  an important new customer signs up, I want to be notified, so I can start
  a conversation with them."
- **Quote the request.** When the story comes from something a user said,
  include their words and link the source.

## The problem before the solution

- **State the problem even when the solution is obvious**, with one specific
  case that shows why things as they are do not work. A solution is measured
  against it.
- **If no solution has been agreed, do not write one in.**
- **If a solution has been agreed, say so plainly.** Give the main elements,
  who decided, and what was ruled out.
- **A constraint is a requirement. A plan is not.** "Must use the existing
  sign-in service" belongs on the ticket. "Add a method to the session
  class" does not.

## How we will know it is done

Every story ticket carries acceptance criteria. Agree them, then write them:
criteria written alone and never agreed are guesses.

- **Each one says what the product does, not how it is built.** "The
  exported file opens in a PDF reader and shows every line item", not "the
  export service is implemented". A person using the product could check
  the first. Only a person reading the code could check the second.
- **Plain language, no implementation.** They tell the builder when to stop,
  the tester what to test and the owner what to expect.
- **A rule or an example, whichever is clearer.** A short list of rules
  suits simple conditions. For behaviour that depends on the starting state,
  use given, when, then: the context, the one event, the outcomes. If
  different outcomes are possible from the same givens, a given is missing.
- **Include what happens when it goes wrong.**
- **Say what is out of scope.** One line naming the nearby thing this ticket
  does not cover prevents most arguments at the end.
- **Everything the ticket does not name stays as it is.** If the work turns
  out to need a change outside the scope, that is a decision for whoever
  asked, recorded on the ticket.
- **Leave team-wide standards out.** Test coverage, review and code style
  apply to every ticket.

## Size and splitting

A story whose list of criteria keeps growing, or that cannot be shown
working as one piece, is usually several stories.

- **Every piece must still be a story.** Splitting into "backend",
  "frontend" and "tests" gives three tickets and nothing that can be shown
  until all three are done.
- **Find the simplest complete version first**, and make each embellishment
  its own ticket.
- **Then split along a real seam:**
  - a **spike**: an investigation whose acceptance criteria are the
    questions to answer
  - **paths**: one way through first, such as paying by card before the
    other payment methods
  - **interfaces**: one platform first, or a plain interface before the
    polished one
  - **data**: one format or one kind of record first
  - **rules**: the main rule first, with the validations and limits after
- **Criteria or separate tickets?** Split when the story is too big, or when
  its parts would be given different priorities. Keep them as criteria on
  one ticket when they are small and wanted together.
- **Link the pieces** to what they were split from.

## After it is filed

- **The description is the current agreement.** When a question is answered
  or a requirement changes, edit the description and say in a comment what
  changed and who agreed.
- **A change to the criteria is a change of scope.** Treat it as a decision,
  with a name on it, never as a quiet edit.
- **Work discovered on the way gets its own ticket.** Link it.
- **A progress note says what is now true.** Which criteria are met, what is
  left, what it is waiting on.
- **Ask questions on the ticket, and fold the answers in.** The result goes
  into the description.
- **Close against the criteria.** Say that each one holds and how it was
  checked, link the change, and name anything that was dropped and the
  ticket it moved to.

## What does not belong on the ticket

The ticket holds the need, the agreement and the outcome. How the code was
changed, and why it was changed that way, belongs with the code.

| The note | Where it goes |
| --- | --- |
| Who wants it, why, what done means, what was decided, how it ended | The ticket |
| A constraint the builder must respect | The ticket |
| Why the change is built this way, what else was considered, how it was tested | The commit message or the pull request description |
| Something a future reader of the code must know and that stays true | A comment in the code, or the documentation in the repository |
| A decision that shapes the structure of the system | A decision record in the repository |
| The plan of which files and functions to touch, and what was tried | Your own working notes, or nowhere |

A question settles most cases:

> Would someone who will never read the code need this?

If yes, it goes on the ticket, in their terms. If no, it goes with the
change.

## Reviewing a story ticket

Ask of each ticket:

1. Does the title say what someone will be able to do?
2. Does it name who wants this and why, and is that true?
3. Is the problem stated, apart from any solution?
4. Could a person check each acceptance criterion without reading the code?
5. Does it say what is out of scope?
6. Is every requirement on it something that was agreed, with open
   questions marked as open?
7. Would it deliver something noticeable if it were the only ticket
   finished?
8. Is it small enough to finish and show as one piece, and if not, where
   is the seam?
9. Can it be understood without the author's session and without reading
   the comments?
10. Is there anything on it that belongs with the code change instead?

A "no" to 3 or 4 means the ticket is not ready to be worked on. A "no" to 7
usually means it is a task, or a layer of a story.
