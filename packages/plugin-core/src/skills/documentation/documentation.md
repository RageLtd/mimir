---
name: documentation
description: Principles for writing, updating and reviewing documentation that stands apart from the code, for any language, framework or documentation tool, meaning a README, a getting-started guide, a tutorial, a how-to guide, reference pages, or an explanation of how or why something works. Use this whenever you write or edit a README or anything under a docs folder, document a feature, a command, a configuration option, an API or a setup procedure, or change code that existing documentation describes. Use it when deciding what kind of page a piece of content belongs on, what a README must say and in what order, how much to write, whether to repeat something or link to it, and whether reference should be written by hand or generated. Use it when adding a command, a code example or installation steps to a page, and when documentation has gone stale, cannot be found, or mixes a lesson, instructions, reference and background on one page. Also use it when reviewing someone else's documentation or briefing someone to write it. For comments and doc comments inside source files, use the code-comments skill. It is about how to think, not about any one tool's markup.
---

# Documentation

Documentation is what lets someone use a thing without reading its code or
asking its author. Steve Losh puts the whole job in one sentence, and
everything below follows from it:

> The purpose of technical documentation is to take someone who has never
> seen your project, teach them to be an expert user of it, and support
> them once they become an expert.

That is three readers with three different needs. Most bad documentation
comes from writing for all of them on one page.

## The kinds of documentation

Daniele Procida's Diátaxis sorts documentation by what the reader needs at
that moment. Two questions place any piece of content: does it guide what
the reader does, or what the reader knows? Is the reader studying, or
working?

| Kind | The reader is | It gives them | Written as |
| --- | --- | --- | --- |
| Tutorial | studying, by doing | a first success | a lesson with one path |
| How-to guide | working, by doing | a task finished | steps towards a stated goal |
| Reference | working, and needs a fact | the fact | plain description |
| Explanation | studying, and needs to understand | the why | discussion |

Jacob Kaplan-Moss names three kinds, Losh four, Google five. They draw the
lines in slightly different places and agree on the rule that matters,
which Google states as: know the types, and do not mix them. A page has one
purpose.

Use the kinds to judge the page in front of you, not as a filing plan.
Procida is blunt about creating four empty sections to fill in later:
"Don't do that. It's horrible." Structure comes from pages that are each
well formed.

## The two ways documentation fails you

- **It is wrong.** It was true once, or it was never run. In a study of
  878 documentation complaints across open-source projects, Aghajani and
  others found that more than half were about content: something missing,
  out of date or incorrect. Half of the correctness problems were in code
  examples, and a fifth in installation instructions. A reader who is
  burned once stops trusting the rest.
- **The answer is there and the reader cannot get to it.** It is on a page
  nobody would look at, or in the ninth paragraph, or mixed in with
  material for a different reader. In the same study, half of the usability
  complaints were about information that existed and could not be found.

Formatting is not on this list. When the same researchers surveyed 146
practitioners, 88% called unclear documentation an important problem and
33% said the same of formatting.

## Before you write

Answer four questions. Google's writing course asks them of every
document.

1. **Who is reading?** Name the role and what they already know. Experts
   forget what a newcomer has not been told: Google calls this the curse of
   knowledge. Unless you are writing for people already on the project, you
   must explain more than you expect.
2. **Why are they reading?** To decide whether to use it, to get it
   running, to finish a task, to look something up, to understand it.
3. **What should they be able to do afterwards?** One or two things. If the
   list is longer, it is more than one page.
4. **Which kind of page is that?** See the table above.

Then say it on the page. Google's advice is to state the scope, and also
the nearby thing a reader might expect and will not find here.

## The README

A README is the first page and often the only one read. Its reader is
deciding whether to go any further, so order it by how soon each part lets
them decide. Art of README calls this cognitive funnelling: the broadest
facts first, the detail only an interested reader wants last.

1. **What it is**, in one sentence, with any term a newcomer would not know
   defined.
2. **Why someone would want it**: the problem it solves. Losh's three
   questions for a first encounter are what is this, why would I care, and
   is it worth the effort.
3. **What it looks like in use**: the shortest real example.
4. **How to install it and run it**, even when that is one standard
   command.
5. **Where the rest is**: links to guides and reference, how to get help,
   how to contribute, the licence.

- **Keep it short.** Art of README: as short as it can be without being
  any shorter. Detail goes on its own pages, linked.
- **State limits and caveats where the reader decides**, not at the end.
- **Do not let it become the manual.** When a section grows past what a
  newcomer needs, move it out and link it.
- **Consider writing it first.** Tom Preston-Werner's argument is that
  describing how the thing is used, before it exists, is the cheapest time
  to find out the design is wrong.

## A tutorial

A tutorial is a lesson. The reader has not used the thing before, and the
goal is that they succeed at something and want to go on.

- **One path, no choices.** Procida: a tutorial does not offer
  alternatives. Pick the options for the reader and leave the rest for
  other pages.
- **Something visible, soon.** Losh asks for a short guide that gets
  something on the screen. Kaplan-Moss's rule of thumb is a first success
  inside half an hour.
- **Say what the reader will see after each step**, so they know they are
  still on the path.
- **Keep explanation to a sentence and a link.** Procida's rule is to
  ruthlessly minimise explanation, because it is only useful at the moment
  the reader wants it. MDN's advice to lay out the what and the why before
  the how suits an explanation page. In a lesson it stands between the
  reader and the first result.
- **Follow it yourself, start to finish, on a clean setup.** A tutorial
  that fails halfway is worse than none. 65% of the practitioners surveyed
  called a faulty tutorial an important problem.

## A how-to guide

A how-to guide gets a competent reader through one task.

- **Title it with the task.** Procida's examples: "How to integrate
  application performance monitoring" is a title. "Application performance
  monitoring" could be about anything.
- **Start from the reader's goal, not from the machinery.** "How to rotate
  the signing key", not "Using the key command".
- **Assume competence.** Leave out what the reader already knows. Procida
  notes how often guides explain that a device is switched on with the
  power switch.
- **Put the condition before the instruction**: "If you use a proxy, set
  …". Say where the path forks, and what to do when the usual thing does
  not work. Real work does not follow one path.
- **Leave the full list of options to reference**, and link to it.

## Reference

Reference is consulted, not read. It states what is there and how it
behaves.

- **Describe, and only describe.** No instruction, no opinion, no history.
  Procida's words for it are austere, accurate and complete.
- **Arrange it like the thing it describes**: the same names, the same
  grouping, the same order. A reader uses it as a map.
- **Make every entry the same shape**, so a reader scanning for one fact
  finds it in the same place each time.
- **Be complete here and nowhere else.** Every option, every default,
  every error. This is the one kind of page where leaving something out is
  a defect.

**Generate it or write it by hand?** The sources disagree. Kaplan-Moss
calls auto-generated documentation "almost worthless" and Losh urges
writing reference by hand. Google's position is that reference should be
single-sourced from the code, and Procida calls generation a powerful way
to keep reference accurate. This skill sides with generating it from
the code and its comments, because the measured failure is documentation
that no longer matches the code. The complaint against generated reference
still stands in one form: it is not the documentation. Nobody can look up
a name they were never taught.

## Explanation

Explanation is for understanding: why it is built this way, how the parts
fit, what was traded for what.

- **Its title could start with "About".**
- **It can hold opinion and alternatives**, and say which was chosen and
  why.
- **Keep steps and specifications out of it.** They have pages of their
  own, and they are lost when they are buried here.
- **This is where design reasoning goes.** Google's advice is to keep
  design decisions out of the description of an interface: the user of it
  does not need them.

## Examples and commands

Readers go to the example first, and it is where documentation is most
often wrong.

- **Run every one before you write it down**, and again when the code
  under it changes. Google asks that sample code be treated like production
  code: it builds, it does what it claims, and it is tested.
- **Make it complete enough to run as written.** A reader pastes it.
  Google's warning is that documentation built from loose snippets decays,
  because nobody tests a snippet. Art of README suggests keeping the
  README's example as a file in the repository.
- **Show the common case first**, then harder ones in order.
- **Show what the reader should see**: the output, or the result.
- **Make it show why someone would use the thing**, not only that it can
  be called. The Rust API guidelines make this point about every example.
- **Do not put a value in an example that must not be copied**: a real
  key, a real host, a setting that is unsafe outside a test.

## Writing the page

- **Put the most important thing first.** Google: assume the reader stops
  after the first paragraph.
- **Let a reader who arrives from a search know where they are.** Mark
  Baker's rule is that every page is page one. Say what the page covers
  and what it assumes, and link to what a reader would need first. Only a
  tutorial may assume the reader read the page before it.
- **Address a qualified reader.** Baker again: give the others enough to
  see they are not ready, and a link to get ready. Do not turn every page
  into a textbook.
- **One idea to a sentence, one topic to a paragraph.** Short sentences.
  Plain words. Many readers are reading a second language, or a
  translation.
- **One term for one thing, all the way through.** MDN's example: having
  called it a browser, do not switch to "user agent". Losh: you do not need
  a thesaurus.
- **Define a term where it first appears.**
- **Say who does what.** "The server retries the request" or "retry the
  request", never "the request is retried".
- **Headings say what is under them.** A reader scanning headings should
  find their section.
- **Numbered lists for steps, bullets for the rest, a table for values
  that share columns.**
- **Link text names the destination.** Never "here".
- **Emphasise little.** GitHub's limit is a tenth of the text.
- **Do not announce what is not there yet.** Google: document what exists.

## How much to write

The sources pull in opposite directions. Kaplan-Moss wants guides to be
comprehensive, Losh says to err on the side of explaining too much, and
the rustdoc book says the more the better. GitHub's principle is "just
enough docs", because "anything added dilutes everything else", and 55% of
the practitioners surveyed called superfluous content an important
problem.

They are describing different pages. Google's observation is that a
document is rarely complete, accurate and clear all at once. So choose by
kind:

- **Reference is complete.**
- **A README, a tutorial and a how-to guide are as short as will work.**
  Cover what most readers need. An edge case goes to reference, or to a
  guide of its own.
- **An explanation covers its topic and stops at its edge.**

**Repeat or link?** Write the Docs accepts some repetition, since a page
must make sense alone. Duplicated content is also a measured problem: when
one copy changes, the other becomes a lie. Repeat the sentence a page needs
in order to stand alone, and link for everything past that. Never keep the
same procedure in two places.

## Keeping it true

Write the Docs' rule: treat incorrect documentation as worse than missing
documentation.

- **Change the documentation in the same change as the code.** Google
  found documentation improved once it lived beside the source, went
  through the same review, and was owned like code.
- **When behaviour changes, search for every page that mentions it.** The
  page you remember is not the only one. Outdated references were the most
  common staleness complaint in the study.
- **Delete what is no longer true.** If you cannot replace it now, remove
  it and say what is missing. An empty placeholder page misleads too.
- **Write so that it ages slowly.** Leave out version numbers, dates and
  counts that the page does not need.
- **Do not keep a list of questions and answers as documentation.** Write
  the Docs' objection is that such a page fills with unrelated material
  and goes stale. Put each answer on the page it belongs to.

## Your own habits

This section is not drawn from the sources. It covers what goes wrong when
the writer is an agent that has just changed the code.

- **You have just made a change, and the reader has not.** Write what is
  true now. "Now supports", "new", "no longer", "has been changed to" and
  "previously" describe a change. A reader arriving in six months has no
  before. The story of the change belongs in the commit message.
- **Run it or do not write it.** Every command, path, flag, option name
  and output on the page is one you ran or read in the code during this
  work. If you could not check something, leave it off the page and tell
  the person you are working for.
- **Do not write what the software probably does.** A plausible sentence
  about behaviour you have not confirmed is the worst thing you can add.
  Find out, or ask.
- **Look for the page that already covers it before creating one.** A
  second page on the same subject makes both harder to find and one of
  them wrong later.
- **Nothing from your session goes on the page**: not the conversation,
  the ticket, the reviewer, or what you tried first.
- **Do not sell and do not pad.** No "powerful", "simple", "seamless" or
  "easy". No closing summary that repeats the page.

## What does not belong in documentation

| The note | Where it goes |
| --- | --- |
| What the thing does and how to use it, as it is now | The documentation |
| What changed in a release, and what a user must do about it | The changelog or release notes |
| Why this change was made this way, and what else was considered | The commit message or the pull request description |
| A decision that shapes the structure of the system | A decision record |
| What a caller of one function must know, or why a line is the way it is | A comment in the code: see the code-comments skill |
| Work still to be done | A ticket |

## Reviewing documentation

Ask of each page:

1. Can you say who it is for and what they can do after reading it?
2. Is it one kind of page, or a lesson, a procedure, a reference and an
   essay taking turns?
3. Does the first paragraph tell a reader whether to stay?
4. Would a reader arriving from a search know where they are and what is
   assumed?
5. Has every command and example been run against the code as it is now?
6. Is every statement about behaviour true of the code as it is now?
7. Is anything here a second copy of something kept elsewhere?
8. Does one term mean one thing throughout?
9. Does it describe the thing, or the change that was just made to it?
10. Is there anything on it that belongs in a changelog, a commit message
    or a comment?

A "no" to 5 or 6 means the page is not ready, whatever else is right with
it.

## Sources

Read in November 2026. Check the current pages before quoting them.

- Steve Losh, "Teach, Don't Tell" (the guiding sentence; first contact;
  getting something on the screen; reference alone does not teach; no
  thesaurus; write reference by hand).
- Daniele Procida, Diátaxis (the four kinds and the two questions that
  separate them; the rules for each kind; tutorials against how-to guides;
  titles; a guide and not a plan; no empty structures).
- *Software Engineering at Google*, chapter 10 "Documentation" (do not mix
  types; write for the audience; documentation treated like code, with
  owners and review; single-sourced reference; completeness, accuracy and
  clarity trade off; design decisions out of interface documentation).
- Google, Technical Writing One and Two, and the developer documentation
  style guide (the audience questions; the curse of knowledge; scope and
  non-scope; key points first; sample code that is correct, concise and
  tested; conditions before instructions; do not pre-announce).
- Jacob Kaplan-Moss, "What to write" and "Technical style" (tutorials,
  topical guides and reference; a first success within half an hour;
  comprehensive guides; against auto-generated documentation).
- Emad Aghajani and others, "Software Documentation Issues Unveiled", 2019,
  and "Software Documentation: The Practitioners' Perspective", 2020 (what
  people report as wrong with documentation, and which problems
  practitioners rank as important).
- Kira (hackergrrl), "Art of README" (what a README is for; its parts and
  their order; cognitive funnelling; brevity; a runnable example).
- Tom Preston-Werner, "Readme Driven Development" (write the README
  first).
- Write the Docs, "Documentation principles" and "How to write software
  documentation" (incorrect is worse than missing; some repetition
  accepted; skimmable; version-agnostic; the trouble with FAQs).
- Mark Baker, *Every Page is Page One*, the author's chapter summaries
  (pages that stand alone, establish their context, assume a qualified
  reader and link richly).
- GitHub, "Documentation done right: A developer's guide", and GitHub
  Docs, "Best practices for GitHub Docs" and "Content design principles"
  (clear, concise, structured; most important first; one or two tasks to a
  page; just enough docs; the limit on highlighting).
- MDN, "Creating effective technical documentation" (clarity, conciseness
  and consistency; one idea to a sentence; one term throughout; say who
  performs the action; descriptive link text).
- Rust API Guidelines, "Documentation" (an example shows why someone would
  use the item).
