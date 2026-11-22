---
name: story-tickets
description: Principles for writing, updating and reviewing tickets for stories, features and enhancements in any issue tracker, for any team, meaning a ticket that starts from something a user, customer or operator needs and asks for a change they would notice. Use this whenever you file a story, feature request or improvement, or turn a need raised in a conversation into a ticket. Use it when choosing the title, saying who wants the change and why, deciding whether to describe the problem or the solution, writing acceptance criteria, and stating what is out of scope. Use it when a story is too big and has to be split, when deciding whether detail belongs in acceptance criteria or in separate tickets, and when deciding whether something is a story at all or a task. Use it after filing too, when requirements change, a question is answered, progress is posted, new work is discovered, or the ticket is closed, and when deciding whether a note belongs on the ticket or with the code change. Also use it when reviewing someone else's story or briefing someone to write one. It is about how to think, not about any one tracker's fields or any one process.
---

# Story tickets

A story ticket asks for a change in what someone can do. Gojko Adzic puts
the idea that separates a story from a specification in one sentence, and
everything below follows from it:

> User stories aren't requirements – they are a way to organise a
> collaboration on requirements.

The ticket is the record of that collaboration: who wants what, why, and how
everyone agreed to tell that it is done. It is not a substitute for it.

## What a story ticket is

- **It describes a change someone outside the code would notice.** When it
  is done, a user, a customer, an operator or another system can do
  something they could not do before, or do it better.
- **It is a slice through the whole system, not a layer of it.** Humanizing
  Work's definition: a work item that delivers a valuable change in system
  behaviour, which usually means touching several layers to make it. "Add
  the database column" is a step toward a story.
- **It is small enough to finish and to understand.** Bill Wake's point
  about size is that past a certain size nobody knows what is in scope any
  more.
- **It is negotiable until it is built.** It states the need and the
  conditions for done. It leaves the design to whoever builds it.

Something broken that was supposed to work is a bug ticket. Something too
large to finish as one piece is an epic. A piece of work someone has already
decided on, or work no user would notice, such as an upgrade or a pipeline
change, is a task, and the task-tickets skill covers it. Do not dress a task as a
story: "As a developer, I want…" names someone who builds the system, not
someone who uses it.

## The two ways a story ticket fails you

- **It says what to build and not why.** The builder cannot choose between
  two designs, cannot tell which details matter, and cannot notice that a
  cheaper change would meet the need. Shape Up's warning is that without a
  stated problem there is no test of whether one solution is better than
  another.
- **Nobody can say when it is done.** It has no end, so it grows, and the
  person who asked and the person who built it find out at the end that
  they meant different things.

## Agree first, then write

The authors who invented stories insist that the card is the least of it.
Ron Jeffries names three parts: the card, the conversation and the
confirmation. The card only identifies the requirement. The requirement
itself is worked out by talking, and settled by agreeing how it will be
confirmed.

For whoever writes the ticket, this means:

- **Do not invent requirements to fill the page.** If nobody has said how an
  edge case should behave, that is an open question. Write it down as one,
  addressed to the person who can answer it.
- **Record what was agreed, and by whom.** A decision with a name and a date
  can be trusted or questioned. An unattributed sentence cannot.
- **Write the detail down when the conversation cannot happen later.** Adzic
  and Evans list the honest reasons: the people who know will not be
  available, the reader is in another place or time, or an investigation
  produced findings worth keeping. A ticket read later by someone who cannot
  ask you is exactly this case.

## The title

Most readers see only the title, in a list among other titles.

- **Name the change in behaviour, in plain words.** "Export an invoice as
  PDF", "Search finds chats by title". Dan North's rule is that the title
  describes an activity: once it is delivered, someone can do that thing.
- **Not a solution with no context.** Adzic and Evans: "How much potential
  cash is in blocked projects?" is a good summary and "Cash report" is not.
  The first led to a small pop-up, not a report.
- **Not a topic.** "Notifications" or "Homepage updates" says nothing about
  what will be different.

## Who and why

Every story names who wants the change and what they get from it. How you
phrase that matters much less than whether it is true.

- **The template is optional.** "As a … I want … so that …" is a good prompt,
  and Mike Cohn defends it as who, what and why. Adzic and Evans found no
  evidence that one format beats another, and trace nonsense such as "As a
  trader I want to trade because I want to trade" to filling in a template for
  its own sake. Linear's method drops it entirely and asks for plain
  language. Use it when it helps you think, and write a plain sentence when
  it does not.
- **Name a real person or role.** Check that they exist and that they want
  this. "As a user" and "As the system" usually mean nobody was asked.
- **The why is what the builder designs from.** Cohn's example: "I want a
  spell checker" produces a tool you run afterwards. Adding "so that I don't
  have to worry about spelling mistakes" produces correction as you type.
- **Say when it matters, if it does.** Alan Klement's job story starts from
  the situation instead of the role: "When an important new customer signs
  up, I want to be notified, so I can start a conversation with them." Use
  that form when the trigger explains more than the role does.
- **Quote the request.** When the story comes from something a user said,
  include their words and link the source. Linear's advice is that the
  customer usually describes the pain better than a summary of it.

## The problem before the solution

- **State the problem even when the solution is obvious.** Shape Up asks
  for one specific story that shows why things as they are do not work.
  That story is what a solution gets measured against.
- **If no solution has been agreed, do not write one in.** GOV.UK's team
  lists "the solution" among the things to leave out of a story, and decides
  it as late as possible.
- **If a solution has been agreed, say so plainly.** Give the main elements,
  who decided, and what was ruled out. Shape Up calls the last part the
  no-gos: what this ticket will deliberately not do.
- **A constraint is a requirement. A plan is not.** "Must use the existing
  sign-in service" binds whoever builds it and belongs on the ticket. "Add a
  method to the session class" is one way to build it and does not.

## How we will know it is done

Wake's test for a story is that whoever wants it understands it well enough
to write a test for it. Acceptance criteria are that understanding written
down, and every story ticket carries them.

- **Each one says what the product does, not how it is built.** "The
  exported file opens in a PDF reader and shows every line item", not "the
  export service is implemented" or "a `toPdf` method exists on the
  invoice". A person using the product could check the first. Only a
  person reading the code could check the others.
- **Plain language, no implementation.** GOV.UK's guidance is that criteria
  are read by technical and non-technical people alike, so they tell the
  builder when to stop, the tester what to test and the owner what to
  expect.
- **A rule or an example, whichever is clearer.** A short list of rules
  suits simple conditions: "passwords need at least 12 characters". For
  behaviour that depends on the starting state, use North's given, when,
  then: the context, the one event, the outcomes. If different outcomes are
  possible from the same givens, a given is missing.
- **Include what happens when it goes wrong.** North's cash machine story
  has three scenarios, and two of them are refusals.
- **Say what is out of scope.** One line naming the nearby thing this ticket
  does not cover prevents most arguments at the end.
- **Everything the ticket does not name stays as it is.** A ticket is a
  scoped piece of work, so this holds for every ticket and is never written
  as a criterion. If the work turns out to need a change outside the scope,
  that is a decision for whoever asked, recorded on the ticket.
- **Leave team-wide standards out.** Test coverage, review and code style
  apply to every ticket and do not need repeating on each.

Authors differ on how much to write. Jeffries, James Shore, and Adzic and
Evans treat anything beyond a reminder as a step in the wrong direction,
because detail on the card stands in for the conversation. North and GOV.UK
make the criteria part of the story. This skill sides with North and
GOV.UK: a ticket outlives the conversation and is read by people who were
not in it, so the criteria are written on it. What the first group is
right about is the order. Agree the criteria, then write them. Criteria
written alone and never agreed are guesses.

## Size and splitting

A story whose list of criteria keeps growing, or that cannot be shown
working as one piece, is usually several stories.

- **Every piece must still be a story.** After a split, each ticket
  delivers something a user could notice, alone. Splitting into "backend",
  "frontend" and "tests" gives three tickets that are small and none that is
  valuable, and nothing can be shown until all three are done.
- **Find the simplest complete version first.** Shore's method is to find
  the essence of the story and make each embellishment its own ticket.
  Humanizing Work asks the same question in planning: what is the simplest
  version of this?
- **Then split along a real seam.** Cohn's five, from a thousand stories he
  sorted by how they were split:
  - a **spike**: an investigation whose acceptance criteria are the
    questions to answer
  - **paths**: one way through first, such as paying by card before the
    other payment methods
  - **interfaces**: one platform first, or a plain interface before the
    polished one
  - **data**: one format or one kind of record first
  - **rules**: the main rule first, with the validations and limits after
- **Criteria or separate tickets?** Cohn's rule: split when the story is too
  big, or when its parts would be given different priorities. Keep them as
  criteria on one ticket when they are small and wanted together.
- **Link the pieces.** Each one points to what it was split from, so a
  reader can see the whole.

## After it is filed

- **The description is the current agreement.** When a question is answered
  or a requirement changes, edit the description and say in a comment what
  changed and who agreed. Nobody should have to replay the thread to learn
  what is being built.
- **A change to the criteria is a change of scope.** Treat it as a decision,
  with a name on it, never as a quiet edit.
- **Work discovered on the way gets its own ticket.** Link it. Do not let
  the ticket in hand grow to hold it.
- **A progress note says what is now true.** Which criteria are met, what is
  left, what it is waiting on. It is not an account of what was tried.
- **Ask questions on the ticket, and fold the answers in.** The question and
  the answer stay in the comments. The result goes into the description.
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

Google asks that a change description carry what was changed and why,
including decisions not visible in the source. Lullabot's split is business
discussion in the tracker and technical discussion in the review tool.

Not everyone draws the line here. GOV.UK's team keeps a technical notes
section on the card, Shore allows a jotted technical detail when it helps,
and Simon Willison keeps his whole working record in the issue thread, which
he calls controversial himself. What they have in common is that the notes
are kept apart from the requirement and do not replace it. A question
settles most cases:

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

## Sources

Read in November 2026. The principles have been stable for years, but check
the current pages before quoting them.

- Gojko Adzic, interviewed by InfoQ on *Fifty Quick Ideas to Improve Your
  User Stories* (the guiding sentence), and Gojko Adzic and David Evans,
  the book's sample chapters "Tell stories, don't write them" and "Don't
  worry too much about story format" (requirements by collaboration; the
  honest reasons to write detail down; format matters less than truth;
  describe a behaviour change, not a solution without context).
- Ron Jeffries, "Essential XP: Card, Conversation, Confirmation" (the three
  parts of a story; confirmation by examples).
- Bill Wake, "INVEST in Good Stories, and SMART Tasks" (independent,
  negotiable, valuable, estimable, small, testable; the promise that a test
  could be written).
- Martin Fowler, "User Story" and "Conversational Stories" (stories are not
  fleshed out until they are about to be built; anyone may write and reshape
  them).
- Dan North, "What's in a Story?" (the title describes an activity;
  acceptance criteria as scenarios; given, when, then; all of the required
  context and no more).
- Mike Cohn, "User Story Template: What It Is and Why It Works So Well",
  "The Two Ways to Add Detail to User Stories" and "SPIDR: Five Simple but
  Powerful Ways to Split User Stories" (who, what and why; criteria or
  sub-stories; the five ways to split).
- Humanizing Work, "The Humanizing Work Guide to Splitting User Stories"
  (vertical slices; why splitting by layer fails; the simplest version; the
  spike).
- James Shore, *The Art of Agile Development*, second edition, "Stories"
  (stories are for planning; customer terms and completion criteria; no
  technical stories; split by essence).
- Alan Klement, "Replacing the User Story with the Job Story" (situation,
  motivation and outcome in place of a role).
- Linear, "Write issues not user stories" (the case against the template;
  plain tasks with a defined outcome; quote the user directly).
- Ryan Singer, *Shape Up*, "Write the Pitch" (problem and solution together;
  one specific story as the baseline; no-gos).
- GOV.UK Technology blog, "Creating better acceptance criteria for user
  stories" (criteria in plain language from the user's side; what to leave
  out).
- Industrial Logic, "As a Developer… Is Not a User Story" (a role that
  builds the system is not a user of it).
- Google, "Writing good CL descriptions"; Lullabot, "Guidelines for Writing
  Proper Tickets and Commits"; Simon Willison, "The Perfect Commit" (where
  the reasoning behind a change is recorded, and the opposing view).
