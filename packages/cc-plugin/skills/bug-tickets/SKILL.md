---
name: bug-tickets
description: Load this skill before doing any work on a bug ticket or a report of something broken, ahead of drafting it. Principles for writing, updating and reviewing bug tickets in any issue tracker, for any team, meaning a report that something behaves differently from what was expected. Use this whenever you file a bug, defect, regression, crash or incident follow-up, or turn a failure you found while working into a ticket. Use it when choosing a bug's title, writing steps to reproduce, stating observed and expected behaviour, deciding how much environment detail to give, or reporting a failure you cannot reproduce at will. Use it when deciding whether two problems are one ticket or two, whether to reopen a bug or file a new one, and whether something is a bug at all. Use it after filing too, when you comment on a bug, answer a question on it, post progress, record a cause or a decision, resolve it or close it, and when deciding whether a note belongs on the ticket or with the code change. Also use it when reviewing someone else's bug ticket or briefing someone to write one. It is about how to think, not about any one tracker's fields.
---

# Bug tickets

A bug ticket exists so that someone who was not there can meet the failure
for themselves. Simon Tatham puts the whole idea in one sentence, and
everything below follows from it:

> The aim of a bug report is to enable the programmer to see the program
> failing in front of them.

## What a bug ticket is

- **It reports a difference between what happened and what should have
  happened.** Both halves are needed. Without the second there is only a
  description of the software.
- **It is about behaviour that was supposed to work.** If there is real doubt
  about whether anyone could expect the behaviour to exist, it is a missing
  feature, and a different kind of ticket. GitLab's rule: "people could
  reasonably expect this" does not by itself make something a bug.
- **It has several readers, at different times.** Someone decides whether to
  do the work and how soon. Someone finds and fixes the cause. Someone checks
  the fix. Months later someone with the same symptom searches for it. None of
  them saw what you saw, and most of them will read only the title and the
  first screen.

## The two ways a bug ticket fails you

- **It cannot be acted on.** The reader cannot make the failure happen and
  cannot tell what went wrong. Developers surveyed across Apache, Eclipse and
  Mozilla named the worst problems as errors in the steps to reproduce,
  incomplete information and wrong observed behaviour. A ticket like this
  costs a round of questions before any work starts, or is closed as not
  reproducible.
- **It misleads.** A guess is written as a fact, or the title names a fix
  instead of a problem, and the reader goes looking in the wrong place.
  Tatham's warning is that a wrong diagnosis without the symptoms can make the
  programmer's job harder than no report at all.

## Before you file

- **Make it fail again.** Say whether you can reproduce it at will,
  sometimes, or not at all. Mozilla asks for this in every report because it
  decides how the reader will approach it.
- **Check it still fails on the current version.** A bug already fixed is
  noise.
- **Search for an existing ticket.** If one exists and you have something
  new, such as shorter steps or another environment where it fails, add it
  there. Do not add "I see this too" with nothing else: Mozilla's etiquette
  limits comments to information that helps resolve the bug.
- **Cut the steps down.** Remove steps until the failure stops, then put the
  last one back. Joel Spolsky's tester goes from twenty steps to four before
  filing. Fewer steps mean less for the reader to rule out.

## The title

The title is all that most readers ever see, in a list, a search result or a
notification.

- **Describe the problem, not the fix.** "Cancelling a file copy crashes the
  file manager", not "Add null check to copy dialog". At filing time the fix
  is a guess, and a title that names one hides the symptom from the next
  person who searches for it.
- **Make it identify this bug and no other.** Say what was done and what went
  wrong. "Software crashes" and "Search is broken" fit a hundred tickets.
- **Keep it short.** Mozilla suggests about ten words, under sixty characters.

## The body

Peter Hilton ranks what a bug report holds, most important first. Write them
in this order, each under its own heading or label, so a reader can stop
early and still have the most useful part.

1. **What happened.** Exactly what was observed. Paste error messages as
   text, whole and unedited: they are the program's own account, and text can
   be searched where a screenshot cannot. Add a screenshot or recording when
   the failure is visual.
2. **What was expected.** And where the expectation comes from: the
   documentation, a specification, an earlier version that did it. This is
   what lets the reader decide whether it is a bug at all.
3. **Steps to reproduce.** Numbered, starting from a state the reader can
   reach, one action per step, with the exact input, command or control
   named. "Open the settings page" is an intent. "Press Ctrl+, in the main
   window" is a step. Then follow your own steps once before filing, as
   Tatham advises, to find the one you left out.
4. **Where it happened.** The version or build, when it was seen if the
   system changes often, and whatever about the environment could bear on
   it. Leave out what cannot: in the same survey developers rarely used
   hardware details.
5. **What it costs, and any workaround.** Who is affected and what they
   cannot do. A workaround written as steps tells the reader how bad it is,
   and helps the next person who hits it.

Steps to reproduce are the part developers value most and the part most
often wrong. If you can give only one thing well, give those.

Where you have them, a stack trace, a log excerpt or a failing test are
worth more than prose. The same research found that reports with stack
traces were fixed sooner, and so were reports that were easier to read.

## Facts and guesses

Keep what you saw apart from what you think. Tatham's comparison is a
patient who asks the doctor for a named drug instead of describing the pain.

- **Always give the symptoms.** A diagnosis is an optional extra, never a
  replacement.
- **Label a suspected cause as suspected**, under its own heading, and say
  what you checked and what you did not. "The handler returns before the
  lock is released (read the code, did not confirm under a debugger)" is
  useful. The same claim stated flatly sends the fixer to one place and
  keeps them there.
- **A proposed fix is welcome and separate.** It does not stand in for the
  report.
- **Never fill a gap with a plausible detail.** If you did not run it, say
  so. Mozilla's rule for reports prepared with AI help is that the submitter
  answers for every statement and must have verified it.

## When it will not fail on demand

Most intermittent faults have a pattern nobody has found yet. Give the
reader what would help find it.

- How often: "3 of 10 attempts", not "sometimes".
- What was different when it failed: load, data size, timing, what else was
  running, how long the process had been up.
- When it happened, precisely enough to find it in a log.
- What you tried that did not trigger it.

If you cannot reproduce it and have nothing but the fact that it happened
once, say exactly that, attach what was captured, and let triage decide.

## One bug, one ticket

Mozilla's first instruction is a new report for each issue, so that each one
can be fixed, checked and closed by itself.

- **The test: could one be fixed while the other stays broken?** If yes, they
  are two tickets. A ticket holding two problems has no honest status once
  one of them is fixed.
- **Split by what can be observed, link by suspected cause.** Two symptoms
  you believe share a cause are two tickets that reference each other, until
  someone confirms the cause. If they are confirmed as one, close one as a
  duplicate of the other.
- **A failure found while fixing another gets its own ticket.** Do not add
  it to the ticket you are working on as a comment.
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
- **Prefer more detail to less, in the right place.** Tatham would have you
  say too much before too little. Put the long material, such as a full log,
  in an attachment or a collapsed section, and keep the first screen for the
  five parts above.

## After it is filed

A ticket is read many more times after filing than before. Keep it true.

- **The description is the current truth.** When shorter steps are found,
  the expected behaviour is settled, or the scope changes, edit the
  description and leave a comment saying that you did. GitLab's guideline
  gives the reason: nobody should have to read the whole thread to learn the
  current state.
- **Comment when the reader's picture changes.** It now reproduces. The
  cause is confirmed. A fix is in review. It is blocked, and on what. It will
  not be fixed, and why. A comment is a statement of where things stand, not
  a diary of what was tried.
- **Answer a question by doing what was asked.** If someone asks you to run
  something and report the result, run it and paste the result. Tatham's
  example is a reporter who replied "that won't work" to a command whose
  error message was the whole point of asking.
- **Every change of status carries its reason.** Not reproducible, duplicate
  (of which ticket), by design, will not fix: each needs a sentence a
  stranger would accept. Chromium's triage advice is to be definitive and
  courteous, so the backlog shows only work someone intends to do.
- **Resolving says what fixed it and where.** Link the change and name the
  version that carries it.
- **A fix changes the reported behaviour and nothing else.** A ticket is a
  scoped piece of work, so this holds for every ticket and is never written
  as a line of its own. If the fix has to change something outside the
  report, that is a decision to record on the ticket.
- **Fixed means the original steps now pass.** Run them. Spolsky's rule is
  that anyone may resolve a bug but the person who reported it confirms and
  closes it, because only they know what they saw.
- **One owner at a time.** A bug assigned to nobody, or to a group, is
  waiting.

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

The reasons come from the people who write about the other end of the link.
Google asks that a change description record what was changed and why,
including the decisions that are not visible in the source. Raymond Chen
puts the cause of the problem, the rejected alternatives and the evidence
that the fix works in the pull request description, because that is
point-in-time justification for a reviewer. Michael Nygard keeps significant
decisions as short records in the repository, where they are versioned with
what they describe. Lullabot's working split is business discussion in the
tracker and technical discussion in the review tool.

One author worth hearing disagrees. Simon Willison keeps nearly all of it in
the issue thread: background, the state of the code before, snippets, false
starts and every small decision, often dozens of comments written to
himself, with a one-line commit that links back. His reasons are that the
thread has room, takes images, is easy to find and can be added to after the
commit lands. He says himself that this is controversial and that it depends
on archiving the tracker. It suits a maintainer whose tracker sits beside the
code and whose main reader is himself. Where the ticket is read by people
who will never open the code, the log buries what they came for.

Both sides agree on two things, and they are the part to keep:

- **Write decisions down.** A decision that changes what a reader of the
  ticket should expect goes on the ticket as an outcome: "will fix only the
  export path; the import path is tracked in the linked ticket".
- **Link both ways.** The change names the ticket, and the ticket links the
  change, so a reader on either side can reach the other.

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

## Sources

Read in November 2026. The advice has been stable for decades, but check the
current pages before quoting them.

- Simon Tatham, "How to Report Bugs Effectively" (the guiding sentence; facts
  apart from speculation; symptoms before diagnosis; a fix is no substitute
  for a report; intermittent faults; be specific, be careful of pronouns,
  read it back; never make up an answer to a question).
- Mozilla, "Bug Writing Guidelines" (one report per issue; reproducible at
  will, occasionally or not at all; the summary explains the problem and not
  the solution; precise steps, expected and actual results; test the current
  build) and "Bugzilla Etiquette" (comments limited to what helps resolve
  the bug; reasons before reopening; the submitter answers for AI-assisted
  content).
- Joel Spolsky, "Painless Bug Tracking" (the three parts of every report;
  minimal steps; one owner at all times; the ways to resolve; the reporter
  closes).
- Peter Hilton, "Minimum viable bug report" and the four articles that
  follow it (the five parts in priority order; error text over screenshots;
  expected behaviour and why it must be stated; minimal steps; versions and
  timestamps; workaround as a measure of impact).
- Thomas Zimmermann, Rahul Premraj, Nicolas Bettenburg and others, "What
  Makes a Good Bug Report?", IEEE Transactions on Software Engineering, 2010
  (what developers use most and least; the most severe problems in reports;
  stack traces and readability against time to fix).
- The Chromium Projects, "Bug Life Cycle and Reporting Guidelines" and
  "Triage Best Practices" (what a report needs; be definitive and courteous
  when closing).
- GitLab Handbook, "Issues project management guidelines" and "Using GitLab
  to plan work" (keep the description current and say when you rewrote it;
  bug or missing feature; comment when closing).
- Google, "Writing good CL descriptions"; Raymond Chen, "The comments that
  go into code versus those that go into the pull request description";
  Michael Nygard, "Documenting Architecture Decisions"; Lullabot,
  "Guidelines for Writing Proper Tickets and Commits" (where the reasoning
  behind a change is recorded).
- Simon Willison, "The Perfect Commit" (the opposing view: the issue thread
  as the working record, and what that depends on).
