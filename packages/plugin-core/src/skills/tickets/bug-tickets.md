---
name: bug-tickets
description: Load this skill before doing any work on a bug ticket or a report of something broken, ahead of drafting it. Writing, updating and reviewing bug tickets in any issue tracker, meaning a report that something behaves differently from what was expected. Use whenever you file a bug, defect, regression or crash, turn a failure you found into a ticket, or comment on, resolve or close one.
---

# Bug tickets

A bug ticket exists so that someone who was not there can see the program
fail in front of them.

## What a bug ticket is

- **It reports a difference between what happened and what should have
  happened.** Both halves are needed.
- **It is about behaviour that was supposed to work.** If there is real doubt
  about whether anyone could expect the behaviour to exist, it is a missing
  feature, and a different kind of ticket.
- **It has several readers, at different times.** Someone decides whether to
  do the work and how soon. Someone finds and fixes the cause. Someone checks
  the fix. Months later someone with the same symptom searches for it. None of
  them saw what you saw, and most of them will read only the title and the
  first screen.

## The two ways a bug ticket fails you

- **It cannot be acted on.** The reader cannot make the failure happen and
  cannot tell what went wrong. The usual causes are wrong steps to reproduce,
  missing information and wrong observed behaviour.
- **It misleads.** A guess is written as a fact, or the title names a fix
  instead of a problem, and the reader goes looking in the wrong place.

## Before you file

- **Make it fail again.** Say whether you can reproduce it at will,
  sometimes, or not at all.
- **Check it still fails on the current version.**
- **Search for an existing ticket.** If one exists and you have something
  new, such as shorter steps or another environment where it fails, add it
  there. Do not add "I see this too" with nothing else.
- **Cut the steps down.** Remove steps until the failure stops, then put the
  last one back.

## The title

The title is all that most readers ever see.

- **Describe the problem, not the fix.** "Cancelling a file copy crashes the
  file manager", not "Add null check to copy dialog". At filing time the fix
  is a guess, and a title that names one hides the symptom from the next
  person who searches for it.
- **Make it identify this bug and no other.** Say what was done and what went
  wrong. "Software crashes" and "Search is broken" fit a hundred tickets.
- **Keep it short**: about ten words.

## The body

Write these in this order, each under its own heading or label, so a reader
can stop early and still have the most useful part.

1. **What happened.** Exactly what was observed. Paste error messages as
   text, whole and unedited: text can be searched where a screenshot cannot.
   Add a screenshot or recording when the failure is visual.
2. **What was expected.** And where the expectation comes from: the
   documentation, a specification, an earlier version that did it.
3. **Steps to reproduce.** Numbered, starting from a state the reader can
   reach, one action per step, with the exact input, command or control
   named. "Open the settings page" is an intent. "Press Ctrl+, in the main
   window" is a step. Then follow your own steps once before filing, to find
   the one you left out.
4. **Where it happened.** The version or build, when it was seen if the
   system changes often, and whatever about the environment could bear on
   it. Leave out what cannot.
5. **What it costs, and any workaround.** Who is affected and what they
   cannot do. A workaround written as steps tells the reader how bad it is.

Steps to reproduce are the most valuable part and the part most often wrong.
If you can give only one thing well, give those. A stack trace, a log excerpt
or a failing test is worth more than prose.

## Facts and guesses

Keep what you saw apart from what you think.

- **Always give the symptoms.** A diagnosis is an optional extra, never a
  replacement.
- **Label a suspected cause as suspected**, under its own heading, and say
  what you checked and what you did not. "The handler returns before the
  lock is released (read the code, did not confirm under a debugger)" is
  useful. The same claim stated flatly sends the fixer to one place and
  keeps them there.
- **A proposed fix is welcome and separate.**
- **Never fill a gap with a plausible detail.** If you did not run it, say
  so. You answer for every statement on the ticket.

## When it will not fail on demand

Give the reader what would help find the pattern.

- How often: "3 of 10 attempts", not "sometimes".
- What was different when it failed: load, data size, timing, what else was
  running, how long the process had been up.
- When it happened, precisely enough to find it in a log.
- What you tried that did not trigger it.

If you have nothing but the fact that it happened once, say exactly that,
attach what was captured, and let triage decide.

## One bug, one ticket

- **The test: could one be fixed while the other stays broken?** If yes, they
  are two tickets.
- **Split by what can be observed, link by suspected cause.** Two symptoms
  you believe share a cause are two tickets that reference each other, until
  someone confirms the cause. Then close one as a duplicate of the other.
- **A failure found while fixing another gets its own ticket.**
- **Reopen when the original steps still fail after a fix.** File a new
  ticket, linked to the old one, when the symptom is similar but the steps or
  the cause differ.

## Writing it so it cannot be misread

- **Be specific.** If something can be done two ways, say which you used.
- **Repeat the noun.** "I closed the warning window and the app crashed",
  not "I closed it and it crashed".
- **Make it stand alone.** The reader has not seen your session, your
  conversation or the other ticket. Name things as the product names them,
  and link what you refer to.
- **Prefer more detail to less, in the right place.** Put the long material,
  such as a full log, in an attachment or a collapsed section, and keep the
  first screen for the five parts above.

## After it is filed

- **The description is the current truth.** When shorter steps are found,
  the expected behaviour is settled, or the scope changes, edit the
  description and leave a comment saying that you did.
- **Comment when the reader's picture changes.** It now reproduces. The
  cause is confirmed. A fix is in review. It is blocked, and on what. It will
  not be fixed, and why. A comment says where things stand; it is not a diary
  of what was tried.
- **Answer a question by doing what was asked.** If someone asks you to run
  something and report the result, run it and paste the result.
- **Every change of status carries its reason.** Not reproducible, duplicate
  (of which ticket), by design, will not fix: each needs a sentence a
  stranger would accept.
- **Resolving says what fixed it and where.** Link the change and name the
  version that carries it.
- **A fix changes the reported behaviour and nothing else.** If the fix has
  to change something outside the report, that is a decision to record on
  the ticket.
- **Fixed means the original steps now pass.** Run them. The person who
  reported it confirms and closes it.
- **One owner at a time.**

## What does not belong on the ticket

The ticket holds the problem and its outcome. How the code was changed, and
why it was changed that way, belongs with the code.

| The note | Where it goes |
| --- | --- |
| What is wrong, for whom, how to see it, what was decided, how it ended | The ticket |
| Why this change is the right fix, what else was considered and rejected, how it was tested | The commit message or the pull request description |
| Something a future reader of the code must know and that stays true | A comment in the code, or the documentation in the repository |
| A decision that shapes the structure of the system | A decision record in the repository |
| What was tried along the way and led nowhere | Your own working notes, or nowhere |

- **Write decisions down.** A decision that changes what a reader of the
  ticket should expect goes on the ticket as an outcome: "will fix only the
  export path; the import path is tracked in the linked ticket".
- **Link both ways.** The change names the ticket, and the ticket links the
  change.

A question settles most cases:

> Would someone who will never read the code need this?

If yes, it goes on the ticket, in their terms. If no, it goes with the
change.

## Reviewing a bug ticket

Ask of each ticket:

1. Does the title name the problem, and only this problem?
2. Could a stranger make it fail from the steps alone, and has the author
   followed them?
3. Are the observed and the expected behaviour both stated, with error text
   pasted exactly?
4. Is everything stated as fact something the author saw, and is every guess
   labelled as one?
5. Does it say how often it fails, and on what version?
6. Is it one problem, and is it a bug at all?
7. Can it be understood without the author's session, and without reading
   the comments?
8. Does the description match what is known today?
9. Is there anything on it that belongs with the code change instead?
10. If it is resolved, does it say why, link the change, and has someone run
    the original steps?

A "no" to 2 or 4 means the ticket is not ready to be worked on.
