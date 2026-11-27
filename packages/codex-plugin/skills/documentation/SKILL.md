---
name: documentation
description: Writing, updating and reviewing documentation that stands apart from the code, meaning a README, a tutorial, a how-to guide, reference pages or an explanation. Use whenever you write or edit a README or anything under a docs folder, document a feature, command, option or procedure, or change code that existing documentation describes. For comments inside source files, use the code-comments skill.
---

# Documentation

Documentation is what lets someone use a thing without reading its code or
asking its author. It takes someone who has never seen the project, teaches
them to use it, and supports them once they know it. Those are different
readers with different needs, and most bad documentation comes from writing
for all of them on one page.

## The kinds of documentation

Two questions place any piece of content: does it guide what the reader does,
or what the reader knows? Is the reader studying, or working?

| Kind | The reader is | It gives them | Written as |
| --- | --- | --- | --- |
| Tutorial | studying, by doing | a first success | a lesson with one path |
| How-to guide | working, by doing | a task finished | steps towards a stated goal |
| Reference | working, and needs a fact | the fact | plain description |
| Explanation | studying, and needs to understand | the why | discussion |

A page has one purpose. Use the kinds to judge the page in front of you, not
as a filing plan: do not create four empty sections to fill in later.

## The two ways documentation fails you

- **It is wrong.** It was true once, or it was never run. Code examples and
  installation steps are where it is wrong most often. A reader who is burned
  once stops trusting the rest.
- **The answer is there and the reader cannot get to it.** It is on a page
  nobody would look at, or in the ninth paragraph, or mixed in with material
  for a different reader.

Formatting is not on this list.

## Before you write

1. **Who is reading?** Name the role and what they already know. Unless you
   are writing for people already on the project, you must explain more than
   you expect.
2. **Why are they reading?** To decide whether to use it, to get it running,
   to finish a task, to look something up, to understand it.
3. **What should they be able to do afterwards?** One or two things. If the
   list is longer, it is more than one page.
4. **Which kind of page is that?**

Then say it on the page: the scope, and the nearby thing a reader might
expect and will not find here.

## The README

A README is the first page and often the only one read. Its reader is
deciding whether to go any further, so order it by how soon each part lets
them decide.

1. **What it is**, in one sentence, with any term a newcomer would not know
   defined.
2. **Why someone would want it**: the problem it solves.
3. **What it looks like in use**: the shortest real example.
4. **How to install it and run it**, even when that is one standard command.
5. **Where the rest is**: links to guides and reference, how to get help, how
   to contribute, the licence.

- **Keep it short.** Detail goes on its own pages, linked.
- **State limits and caveats where the reader decides**, not at the end.
- **Do not let it become the manual.**

## A tutorial

A tutorial is a lesson. The reader has not used the thing before, and the
goal is that they succeed at something and want to go on.

- **One path, no choices.** Pick the options for the reader.
- **Something visible, soon.**
- **Say what the reader will see after each step**, so they know they are
  still on the path.
- **Keep explanation to a sentence and a link.**
- **Follow it yourself, start to finish, on a clean setup.** A tutorial that
  fails halfway is worse than none.

## A how-to guide

A how-to guide gets a competent reader through one task.

- **Title it with the task.** "How to integrate application performance
  monitoring" is a title. "Application performance monitoring" could be about
  anything.
- **Start from the reader's goal, not from the machinery.** "How to rotate
  the signing key", not "Using the key command".
- **Assume competence.** Leave out what the reader already knows.
- **Put the condition before the instruction**: "If you use a proxy, set …".
  Say where the path forks, and what to do when the usual thing does not
  work.
- **Leave the full list of options to reference**, and link to it.

## Reference

Reference is consulted, not read. It states what is there and how it behaves.

- **Describe, and only describe.** No instruction, no opinion, no history.
- **Arrange it like the thing it describes**: the same names, the same
  grouping, the same order.
- **Make every entry the same shape**, so a reader scanning for one fact
  finds it in the same place each time.
- **Be complete here and nowhere else.** Every option, every default, every
  error.

Generate reference from the code and its comments where you can, because the
commonest failure is documentation that no longer matches the code. Generated
reference is still not the whole documentation: nobody can look up a name
they were never taught.

## Explanation

Explanation is for understanding: why it is built this way, how the parts
fit, what was traded for what.

- **Its title could start with "About".**
- **It can hold opinion and alternatives**, and say which was chosen and why.
- **Keep steps and specifications out of it.**
- **This is where design reasoning goes**, not in the description of an
  interface.

## Examples and commands

Readers go to the example first, and it is where documentation is most often
wrong.

- **Run every one before you write it down**, and again when the code under
  it changes.
- **Make it complete enough to run as written.** A reader pastes it.
- **Show the common case first**, then harder ones in order.
- **Show what the reader should see**: the output, or the result.
- **Make it show why someone would use the thing**, not only that it can be
  called.
- **Do not put a value in an example that must not be copied**: a real key, a
  real host, a setting that is unsafe outside a test.

## Writing the page

- **Put the most important thing first.** Assume the reader stops after the
  first paragraph.
- **Let a reader who arrives from a search know where they are.** Say what
  the page covers and what it assumes, and link to what a reader would need
  first. Only a tutorial may assume the reader read the page before it.
- **Address a qualified reader.** Give the others a link to get ready. Do not
  turn every page into a textbook.
- **One idea to a sentence, one topic to a paragraph.** Short sentences.
  Plain words.
- **One term for one thing, all the way through.**
- **Define a term where it first appears.**
- **Say who does what.** "The server retries the request" or "retry the
  request", never "the request is retried".
- **Headings say what is under them.**
- **Numbered lists for steps, bullets for the rest, a table for values that
  share columns.**
- **Link text names the destination.** Never "here".
- **Emphasise little.**
- **Do not announce what is not there yet.**

## How much to write

Choose by kind:

- **Reference is complete.**
- **A README, a tutorial and a how-to guide are as short as will work.**
  Cover what most readers need. An edge case goes to reference, or to a guide
  of its own.
- **An explanation covers its topic and stops at its edge.**

Repeat the sentence a page needs in order to stand alone, and link for
everything past that. Never keep the same procedure in two places.

## Keeping it true

Incorrect documentation is worse than missing documentation.

- **Change the documentation in the same change as the code.**
- **When behaviour changes, search for every page that mentions it.** The
  page you remember is not the only one.
- **Delete what is no longer true.** If you cannot replace it now, remove it
  and say what is missing.
- **Write so that it ages slowly.** Leave out version numbers, dates and
  counts that the page does not need.
- **Do not keep a list of questions and answers as documentation.** Put each
  answer on the page it belongs to.

## Your own habits

This is what goes wrong when the writer is an agent that has just changed the
code.

- **You have just made a change, and the reader has not.** Write what is true
  now. "Now supports", "new", "no longer", "has been changed to" and
  "previously" describe a change. The story of the change belongs in the
  commit message.
- **Run it or do not write it.** Every command, path, flag, option name and
  output on the page is one you ran or read in the code during this work. If
  you could not check something, leave it off the page and tell the person
  you are working for.
- **Do not write what the software probably does.** Find out, or ask.
- **Look for the page that already covers it before creating one.**
- **Nothing from your session goes on the page**: not the conversation, the
  ticket, the reviewer, or what you tried first.
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
10. Is there anything on it that belongs in a changelog, a commit message or
    a comment?

A "no" to 5 or 6 means the page is not ready, whatever else is right with it.
