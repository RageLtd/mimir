---
name: code-comments
description: Principles for writing, updating and reviewing the documentation that lives inside source code, in any language, meaning doc comments and docstrings on functions, types, modules and files, and comments inside a function body. Use this whenever you write or change code and are deciding whether a comment is needed, what it should say, or whether an existing one is still true. Use it when deciding whether a function, method, class, type, module, package, constant or configuration value needs a doc comment at all, given what an editor already shows of its types, when writing what a caller needs to know about errors, panics, side effects, concurrency or special cases, and when choosing between a comment and a better name or structure. Use it when a comment restates the code, describes the change instead of the code, has gone stale, or holds commented-out code, and when writing a TODO. Use it when deciding whether a note belongs in a comment, a commit message, the documentation or a ticket. Also use it when reviewing someone else's comments or briefing someone to write code. For READMEs, guides and reference pages, use the documentation skill. It is about how to think, not about any one language's comment syntax or documentation tool.
---

# Comments in code

A comment is the part of a program written only for the next person to
read it. John Ousterhout gives the reason comments exist at all, and
everything below follows from it:

> There is a lot of important information that simply cannot be expressed
> in code.

A comment is for that information and nothing else. Whatever the code
already says, the code says better.

## Two kinds of comment

Google's engineering book separates them by reader, and they follow
different rules.

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
  comment did not. PEP 8 opens its section on comments with this:
  "Comments that contradict the code are worse than no comments."

## Before you write one

- **Try the code first.** The order is Jeff Atwood's: "Only at the point
  where the code cannot be made easier to understand should you begin to
  add comments." What is left for the comment is the reason. Code can only
  tell you how the program works, he writes, and comments can tell you why.
  So: a better name, a named constant, a value pulled
  into a named variable, a type that says what a bare flag could not.
  Google's C++ guide lists these for an unclear argument and puts a comment
  at the end, "as a last resort". Kernighan and Plauger, quoted by Ellen
  Spertus: "Don't comment bad code — rewrite it."
- **If the comment is hard to write, look at the design.** Spertus makes
  this a rule. Google says an interface that cannot be described in a
  paragraph or two is usually not well thought out, and Ousterhout treats a
  long comment as a sign he struggled to find a simple explanation.
- **A monster name is not the answer either.** In their published debate,
  Robert Martin moves information into names like
  `isLeastRelevantMultipleOfLargerPrimeFactor`. Ousterhout's reply is that
  a shorter name with a comment is easier to read. When a name needs a
  clause, the clause is a comment.

## Interface comments

### When one is needed

Start from what a caller sees when their editor shows the declaration: the
name, the parameter names and their types, and the return type, written or
inferred. If that answers what a caller would ask, write nothing.

The sources mostly say otherwise. Go, Rust and Python ask for a doc
comment on every public item, and Google's C++ guide says even private
functions "are not exempt". Martin holds that well-named functions and
arguments are usually enough. This skill sides with need over visibility,
whether the declaration is public or internal. It is a judgment of this
skill and not a finding of the sources: those conventions were written for
a reader of a header file or a generated page, and a caller now reads the
signature where they are typing. The same sources already concede the
ground. The rustdoc book sees no benefit in writing out what the types
show, PEP 257 leaves to introspection what introspection can report, and
Google's C++ guide notes that a comment need not say a function can fail
when its return type says so.

Write an interface comment in these cases:

- **The tools cannot show the types.** An untyped language, a value typed
  as "anything", a map keyed by strings, a callback or a structure built
  at run time. Here the comment carries what a type would have: what goes
  in, what comes out, and in what shape.
- **A caller's question is left open after the types have said all they
  can.** First try to make the type say it: a unit in the type's name, an
  enumeration in place of a flag, a result type in place of a failure
  nobody declared. Comment what remains. Ousterhout's example is a
  function that adds a song, with a title and a list of authors, to a
  library. Its types are plain, and a caller still has to ask whether the
  order of authors matters and what happens if a song with that title is
  already there.
- **The project requires one.** A lint rule, or a published library whose
  reference pages are generated from these comments. Follow the project.

### What it says

- **The first sentence stands alone.** It says what the thing does or is.
  Tools show that sentence by itself in lists and search results, so Go,
  rustdoc and PEP 257 all require it.
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
- **Not how it works.** Go's guidance: a doc comment does not explain the
  algorithm used in the current implementation. That belongs inside the
  body, if anywhere. A cost the caller must plan for, such as time or
  memory that grows with the input, is part of the interface and is
  stated.
- **Not what the signature already says.** PEP 257 forbids a docstring
  that restates the parameters. The rustdoc book sees no benefit in writing
  out types the tool already shows. The Linux kernel's guide warns against
  boilerplate that "simply reiterates what's obvious from the signature".
- **Not why it was designed this way.** A user of the interface does not
  need that. It goes in an explanation page or a decision record.
- **An example, where use is not obvious.** The Rust API guidelines ask
  that an example show why someone would use the item, not merely that it
  can be called.
- **For something deprecated, what to use instead.**

### Sections and wording

The conventions disagree. Google's book finds a prose sentence clearer
than "Returns:" and "Throws:" sections, because the parts depend on each
other. Rust asks for fixed "Errors", "Panics" and "Safety" sections. PEP
257 writes the summary as a command ("Return the path") and Google's C++
guide as a description ("Returns the path").

Follow the convention of the language and the file. Whatever the
convention, an entry that only repeats a name adds nothing: "`name`: the
name". Leave it out, or say something a caller needs.

### Files, modules and packages

Say what is collected here and who it is for. Google's C++ guide asks for
enough that a later author can tell what does not belong in the file. Go's
asks a package comment to introduce the package and, for a large one,
point at the parts that matter most.

## Implementation comments

Write one only when the reason for the code is not visible in the code.
Never to say what the code does.

What qualifies:

- **Why this, and not the obvious thing.** The simpler form was tried and
  is wrong, slow or unsafe, and a reader would otherwise "fix" it. Spertus:
  explain code that someone else might consider unneeded.
- **A constraint or an order that must be kept.** antirez's example from
  Redis is a counter incremented at the top of a loop, with a comment
  saying why it cannot move to the bottom. Without the comment, moving it
  looks harmless.
- **A workaround for a fault somewhere else**, naming the fault and what
  would let the workaround be removed.
- **Something that must change together with this**, which the code cannot
  enforce. antirez calls these checklist comments: "if you add a type here,
  update that function as well". Such a comment is also a sign the two
  places should be one.
- **Knowledge from outside the code that the reader needs**: the formula,
  the protocol rule, the standard. A sentence and a link. antirez calls
  these teacher comments and values them for widening who can read the
  code.
- **Where copied code came from**, as a link.

Data counts as implementation. Google's C++ guide and the kernel's both
ask that a field carry a comment when its name and type do not show an
invariant, a unit, or a value with a special meaning.

### No summaries of what a block does

This is the sharpest disagreement in the sources. antirez fills Redis with
what he calls guide comments, a line above each block saying what it is
about to do, and credits them for the code's readability. Ousterhout
writes comments that say what a block does "in a logical sense". The Linux
kernel's guide says to avoid comments inside a function body: if a function
needs its parts explained, it is too complex. Martin would extract the
block into a named function.

This skill takes the stricter side. A comment in a body carries a reason,
and a summary of the code is not a reason. If a block needs a title, give
it one the compiler can see by making it a function, or leave it alone.
antirez himself names the risk: a guide comment easily becomes a trivial
one, where reading the comment costs as much as reading the code.

## Comments that are never right

- **Code that has been commented out.** antirez: source code is not for
  making backups. The history keeps the old version.
- **The story of a change.** "Fixed the race", "added for the new flow",
  "used to return null", "moved from the handler". A comment describes the
  code as it is. Spertus recommends adding a comment when fixing a bug.
  Keep the part of that which stays true, the condition the code must now
  handle, and put the account of the fix in the commit message.
- **Who wrote it and when.** Version control records that. Google's guide
  suggests deleting an author line when you change the file.
- **A note to the reviewer**, or anything about the session the code was
  written in.
- **A banner, a divider or a closing-brace label** that says where you
  are in the file.

## TODO comments

antirez counts these as debt and tries to avoid them. When one is the
honest thing to write:

- **Point at whoever or whatever has the context.** Google's form is
  `TODO` followed by an issue, a document or a name. Spertus goes further:
  file the issue and reference it.
- **Say what should happen and what would trigger it.** Google asks for a
  specific event, such as "remove when all clients handle the new
  response", in place of "later".
- **Do not leave one for work you could do now.**

## Keeping them true

Missing or wrong: which costs more? Ousterhout puts the cost of a missing
comment at ten to a hundred times that of an incorrect one, and says stale
comments have rarely cost him much. Martin holds that comments as
generally practised are a net loss, and will not trust one until he has
read the code. The evidence does not settle it. Wen and others found that
most code changes are made without any change to the comments around them.
A study of FreeBSD, PostgreSQL and Eclipse found that this alone does not
predict bugs, and that the risk rises where code and comment usually
change together and one time do not. In Aghajani's survey, 49% of
practitioners called wrong comments an important problem and 28% said the
same of missing ones.

What follows for the writer does not depend on who is right:

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

- **Complete sentences, capitalised and punctuated.** Google's guide and
  PEP 8 both ask for them. A comment is read as prose.
- **Be exact.** "Must be called with the lock held", not "be careful
  here".
- **Present tense, about the code.**
- **Use the names the code uses.**
- **Match the comment style already in the file.**

## Your own habits

This section is not drawn from the sources. It covers what goes wrong when
the writer is an agent that has just changed the code.

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

## Sources

Read in November 2026. Check the current pages before quoting them.

- John Ousterhout and Robert C. Martin, "A Philosophy of Software Design
  vs Clean Code", their published debate (the guiding sentence; comments
  as failures against comments as part of the design; interface comments
  and what a signature cannot say; long names against comments; missing
  against incorrect comments; the points they agree on). Their two books
  were read only as quoted there.
- Salvatore Sanfilippo (antirez), "Writing system software: code
  comments" (the kinds of comment found in Redis: function, design, why,
  teacher, checklist and guide comments, and the trivial, debt and backup
  comments to avoid).
- *Software Engineering at Google*, chapter 10 "Documentation" (interface
  and implementation comments have different readers; prose over
  boilerplate sections; an interface that cannot be described briefly).
- Google C++ Style Guide, "Comments" (what file, class, function and
  variable comments say; private functions are not exempt; remedies to try
  before a comment; do not state the obvious; complete sentences; the form
  of a TODO).
- The Go Authors, "Go Doc Comments" (a doc comment on every exported name;
  the first sentence; what the caller needs; no implementation detail;
  package comments; deprecation).
- Rust API Guidelines, "Documentation", and the rustdoc book, "How to
  write documentation" (an example that shows why; Errors, Panics and
  Safety sections; a one-line summary; no repeating of types).
- PEP 257, "Docstring Conventions", and PEP 8, "Comments" (the summary
  line; no restating the signature; comments that contradict the code;
  complete sentences).
- Linux kernel coding style, "Commenting" (say what, not how; avoid
  comments inside a function body; no boilerplate that repeats the
  signature; comment data).
- Ellen Spertus, "Best practices for writing code comments", Stack
  Overflow Blog (comments do not duplicate code or excuse unclear code; a
  comment that is hard to write; unidiomatic code; links to sources and
  references; comments on bug fixes; marking incomplete work).
- Jeff Atwood, "Code Tells You How, Comments Tell You Why" (the order this
  skill follows: make the code as clear as it can be made, and comment only
  past that point; the comment gives the reason).
- Fengcai Wen and others, "A Large-Scale Empirical Study on Code-Comment
  Inconsistencies", 2019 (how seldom code and comments change together).
- "On the relationship between comment update practices and software
  bugs", Journal of Systems and Software, 2012, abstract only (inconsistent
  updates alone do not predict bugs; a break from the usual practice
  does).
- Emad Aghajani and others, "Software Documentation: The Practitioners'
  Perspective", 2020 (how practitioners rank wrong and missing comments).
