---
name: code-comments
description: Writing, updating and reviewing the comments that live inside source code, in any language, meaning doc comments on functions, types, modules and files, and comments inside a function body. Use whenever you write or change code and are deciding whether a comment is needed, what it should say, or whether an existing one is still true, and when you review someone else's comments. For READMEs, guides and reference pages, use the documentation skill.
---

# Comments in code

A comment is the part of a program written only for the next person to
read it. It is for what the code cannot express, and nothing else.
Whatever the code already says, the code says better.

## Two kinds of comment

- **An interface comment** sits on a declaration: a function, a type, a
  module, a file. Many languages call it a doc comment or a docstring. Its
  reader wants to use the thing and should not have to read the body to do
  it.
- **An implementation comment** sits inside a body. Its reader is about to
  change the code and needs to know something the code does not show.

## The two ways comments fail you

- **It says what the code says.** `i = i + 1  // add one to i`. It costs
  the reader a line and teaches them to skip comments, including the one
  that mattered.
- **It says something that is no longer true.** The code changed and the
  comment did not. A comment that contradicts the code is worse than no
  comment.

## Before you write one

- **Try the code first.** A better name, a named constant, a value pulled
  into a named variable, a type that says what a bare flag could not. Code
  tells you how the program works. What is left for the comment is why.
- **If the comment is hard to write, look at the design.** An interface
  that cannot be described in a paragraph or two is usually not well
  thought out.
- **A monster name is not the answer either.** When a name needs a clause,
  the clause is a comment.

## Interface comments

### When one is needed

Start from what a caller sees when their editor shows the declaration: the
name, the parameter names and their types, and the return type, written or
inferred. If that answers what a caller would ask, write nothing. This
holds whether the declaration is public or internal.

Write an interface comment in these cases:

- **The tools cannot show the types.** An untyped language, a value typed
  as "anything", a map keyed by strings, a callback or a structure built
  at run time. Here the comment carries what a type would have: what goes
  in, what comes out, and in what shape.
- **A caller's question is left open after the types have said all they
  can.** First try to make the type say it: a unit in the type's name, an
  enumeration in place of a flag, a result type in place of a failure
  nobody declared. Comment what remains. A function that adds a song, with
  a title and a list of authors, has plain types, and a caller still has
  to ask whether the order of authors matters and what happens if a song
  with that title is already there.
- **The project requires one.** A lint rule, or a published library whose
  reference pages are generated from these comments. Follow the project.

### What it says

- **The first sentence stands alone.** It says what the thing does or is.
  Tools show that sentence by itself in lists and search results.
- **Only what a caller must know and the signature does not show:**
  - the types and shapes, where the tools cannot infer them
  - what the special values mean
  - what it changes besides its return value
  - when it fails, and how: errors, exceptions, panics
  - what the caller must guarantee first, and what happens otherwise
  - whether it is safe to use from several threads at once
  - who owns what is passed in and what is handed back
  - units, ranges, and the meaning of an empty or zero value
  - the special cases
- **Not how it works.** That belongs inside the body, if anywhere. A cost
  the caller must plan for, such as time or memory that grows with the
  input, is part of the interface and is stated.
- **Not what the signature already says.**
- **Not why it was designed this way.** That goes in an explanation page
  or a decision record.
- **An example, where use is not obvious.** It shows why someone would use
  the item, not merely that it can be called.
- **For something deprecated, what to use instead.**

Follow the comment convention of the language and the file. Whatever the
convention, an entry that only repeats a name adds nothing: "`name`: the
name". Leave it out, or say something a caller needs.

### Files, modules and packages

Say what is collected here and who it is for, with enough that a later
author can tell what does not belong.

## Implementation comments

Write one only when the reason for the code is not visible in the code.
Never to say what the code does.

What qualifies:

- **Why this, and not the obvious thing.** The simpler form was tried and
  is wrong, slow or unsafe, and a reader would otherwise "fix" it.
- **A constraint or an order that must be kept**: a counter incremented at
  the top of a loop, with a comment saying why it cannot move to the
  bottom.
- **A workaround for a fault somewhere else**, naming the fault and what
  would let the workaround be removed.
- **Something that must change together with this**, which the code cannot
  enforce: "if you add a type here, update that function as well". Such a
  comment is also a sign the two places should be one.
- **Knowledge from outside the code that the reader needs**: the formula,
  the protocol rule, the standard. A sentence and a link.
- **Where copied code came from**, as a link.

Data counts as implementation. A field carries a comment when its name and
type do not show an invariant, a unit, or a value with a special meaning.

**No summaries of what a block does.** A comment in a body carries a
reason, and a summary of the code is not a reason. If a block needs a
title, give it one the compiler can see by making it a function, or leave
it alone.

## Comments that are never right

- **Code that has been commented out.** The history keeps the old version.
- **The story of a change.** "Fixed the race", "added for the new flow",
  "used to return null", "moved from the handler". A comment describes the
  code as it is. When you fix a bug, keep the part that stays true, the
  condition the code must now handle, and put the account of the fix in
  the commit message.
- **Who wrote it and when.** Version control records that.
- **A note to the reviewer**, or anything about the session the code was
  written in.
- **A banner, a divider or a closing-brace label** that says where you are
  in the file.

## TODO comments

A TODO is debt. When one is the honest thing to write:

- **Point at whoever or whatever has the context**: an issue, a document
  or a name.
- **Say what should happen and what would trigger it**: "remove when all
  clients handle the new response", not "later".
- **Do not leave one for work you could do now.**

## Keeping them true

- **Read the comments on everything you change, and change them in the
  same edit.** That includes the comment above the function, not only the
  ones beside the lines you touched.
- **When you change what something does, look for comments elsewhere that
  describe it**: on its callers, on the module, in the file header.
- **Keep a comment next to the code it describes.** The further away it
  sits, the less likely it is to be seen when that code changes.
- **Delete a comment you find to be wrong**, even if you cannot write the
  right one.
- **Write fewer, and make each one count.** Every comment is something the
  next change must keep true.

## Writing it

- **Complete sentences, capitalised and punctuated.**
- **Be exact.** "Must be called with the lock held", not "be careful
  here".
- **Present tense, about the code.**
- **Use the names the code uses.**
- **Match the comment style already in the file.**

## Your own habits

This is what goes wrong when the writer is an agent that has just changed
the code.

- **Do not explain your change in a comment.** The pull to justify an edit
  to whoever reviews it is strong, and the reviewer is not the reader. That
  explanation goes in the commit message or in your report.
- **Do not narrate.** No comment above a line saying what the line does,
  and no comments marking the steps of your own plan.
- **Leave other people's comments alone** unless the code they describe is
  gone or you have shown them to be wrong. Do not reword, and do not add
  comments to code you were not asked to change.
- **Claim only what you checked.** "Safe for concurrent use" and "never
  returns null" are promises. A comment that asserts something you did not
  verify is worse than silence, because the next reader will trust it.
- **Do not put a doc comment on every function by reflex.** One that
  restates the name and the types is the commonest comment an agent writes
  and the least useful.
- **Default to none inside a body.** Before adding one, state the reason
  it records. If the reason is "so the reader can follow", improve the
  code.

## Where the note goes

| The note | Where it goes |
| --- | --- |
| What a caller must know to use this | The interface comment |
| Why this line is the way it is, for as long as it stays that way | An implementation comment |
| Why this change was made, what else was tried, how it was tested | The commit message or the pull request description |
| How the parts of the system fit together, and why it was designed so | The documentation, or a decision record |
| Work still to be done | A ticket, with a TODO pointing at it only where the code would otherwise mislead |

## Reviewing comments

Ask of the code:

1. Is there an interface comment wherever the signature an editor shows
   leaves a caller's question open, and nowhere else?
2. Could a caller use each function correctly from its name, signature and
   comment, without opening the body?
3. Does any interface comment describe the algorithm, or repeat the
   signature?
4. Does every comment inside a body give a reason the code does not show?
5. Does any comment say what the code says?
6. Is every comment true of the code as it is now, including the ones the
   change did not touch?
7. Does any comment describe the change, the author or the session?
8. Is there commented-out code?
9. Does each TODO say what, and point at who or what knows more?
10. Was a comment used where a name, a constant or a type would have done?

A "no" to 6 is a defect in the change, the same as a failing test.
