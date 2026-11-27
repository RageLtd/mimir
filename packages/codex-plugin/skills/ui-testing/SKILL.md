---
name: ui-testing
description: Writing and reviewing UI tests in any toolkit (web, desktop, mobile, terminal), from the point of view of the person using the app and the person using it through assistive technology. Use whenever you write, change, review or debug a test that clicks, types or reads what is on screen, when choosing how a test finds an element or what it asserts, and when a test "needs" a hook or piece of state the application itself does not use.
---

# UI testing

A UI test is a rehearsal of someone using the software. The more a test
resembles the way the software is used, the more confidence it gives.

## Who is using it

Write every UI test as one of two people, in this order.

1. **The user.** They see what is drawn and act with a pointer, a keyboard, the
   clipboard, a file dropped from elsewhere. They know nothing about function
   names, component trees, CSS classes, internal state or how many times
   something rendered.
2. **The user of assistive technology.** They perceive the interface through
   what it exposes to the platform's accessibility layer: each thing's role
   (button, checkbox, alert), its name (the label a screen reader speaks), its
   state (disabled, checked, expanded) and its value. They move with the
   keyboard. If something is only painted and not exposed, for them it is not
   there.

There is a third "user" you can create by accident: **the test itself.** The
moment a test reaches for something neither real user can perceive (private
state, a method, a class name, a position in a tree), the application has a
consumer that exists only in the test suite. That goes wrong two ways:

- The test **breaks when you refactor** code that still works.
- The test **keeps passing when you break** the behaviour. The handler is no
  longer wired to the button, but the test called the handler directly.

## Start from the instructions you would give a person

Before writing any code, write what you would tell a human tester, in their
words: "Open a chat. Paste a screenshot. A thumbnail appears above the text
box. Press Enter. The message appears with the picture above its text." Then
turn that list into the test, step for step.

If a step cannot be written without naming something internal ("check that the
pending list has two entries"), stop and ask what the person would actually
see. That is the assertion.

## Finding things

Find an element the way a person would point it out to someone else. Prefer
the highest rung that works, and treat needing a lower one as information.

1. **Role and accessible name.** "The button called Send", "the alert that
   says the file could not be read". This is the default for almost
   everything, and it checks for free that the thing is exposed correctly.
2. **Its label**, for form fields.
3. **Its visible text**, for content that is not a control.
4. **Other things a person perceives**: the current value of a field, an
   image's alternative text, a title or tooltip.
5. **A dedicated test hook** (a test id or similar attribute) when nothing a
   person perceives identifies the element, or the text is dynamic.
6. **Never**: structure ("the third child of the second panel"), styling
   (class names, colours), generated ids, or the element's position in a
   component tree.

Choosing between text and a test hook, ask:

> If the content of the element changed, would you want the test to fail?

If the words matter to the person (a button's name, an error's explanation),
find it by those words. If the words are incidental or vary (a timestamp, a
generated title), use a dedicated hook and say so.

### When you cannot find it the way a user would

If a test cannot locate something by role, name or text, the usual cause is
that the interface does not expose that thing to anyone but a sighted user.
The test's failure to find it is the bug report.

So, in order:

1. Ask whether a person using assistive technology could find it. If not, fix
   the interface: give the control a name, use the element that has the right
   role, put the message where it is exposed.
2. Only if the interface genuinely has nothing perceivable to offer, fall back
   to a dedicated test hook.
3. Do not add a back door: an accessor, a copy of the state, a flag that
   exists only so the test can look.

Do not scatter accessibility attributes over an interface just to give tests
something to grab. Add them where the semantics are actually missing.

## Acting

Do what the person does, through the same door.

- **Use real input.** Click, type, press keys, paste, drag, drop. Do not call
  the handler, set the field's value directly, or dispatch a synthetic event
  that skips what a real interaction triggers.
- **Only act on what a person could act on.** It has to be visible, finished
  moving, not covered by something else, and enabled. If your tool lets you
  force an action past those checks, reaching for that is a sign the test is
  about to do something no user can.
- **Go in through the entry point the application uses.** If images reach a
  composer by paste, drop or a file dialog, the test attaches an image by
  pasting, dropping or picking. A method that exists so tests can inject the
  image tests that method, not the product.
- **Reach it the way they would.** For anything a keyboard user must be able
  to do, do it from the keyboard at least once: tab to it, activate it, check
  where focus lands afterwards.

## Asserting

Assert what the person would notice, where they would notice it.

- **What is on screen**: that the thing is there, what it is called, what it
  says, and its state as exposed, not as stored.
- **Where it is**, when placement is the behaviour: the error is next to the
  field, the image is above the text.
- **What happened as a result**, at the edge of the system: the request the
  server received, the record that was saved, the file that was written.
- **That something is absent**, deliberately: assert absence with a query made
  for it, after the moment it would have appeared, or the test passes simply
  because it looked too early.

Do not assert internal state, call counts, private fields or the shape of a
data structure.

Be specific. "The Send button is disabled" fails usefully; "the result is
truthy" does not. If your tool can tell you a control is disabled but cannot
confirm one is enabled, prove enabled by using the control and seeing the
result.

## Waiting

- **Wait for a condition, never for a duration.** "Until the reply appears",
  not "for two seconds".
- **Prefer assertions that retry** until they hold or time out, over reading a
  value once and comparing it.
- **Keep actions out of retried blocks.** A click inside a retried block may
  click any number of times. Retry the looking, not the doing.
- **Know when effects land.** Many toolkits deliver the result of an input
  event after the current update finishes. Assert after the interface has had
  its turn.
- **Control time instead of spending it.** Where the tool offers a virtual
  clock, advance it to trigger timeouts and auto-dismissals.

## Keeping tests independent and honest

- **Each test stands alone.** It sets up what it needs and passes when run by
  itself, in any order.
- **Set up state the fast way, exercise behaviour the real way.** Create the
  account, the saved session or the seeded data directly, then drive the
  interface for the behaviour under test.
- **Own the edges.** Do not let a test depend on a third-party site or a live
  service you do not control. Stand in for it at the boundary.
- **Test a piece of behaviour, not one fact.** Several assertions about one
  coherent action are fine.

## What automation cannot tell you

Say this plainly whenever it applies.

- **Looks.** A test can show that an element exists, has a size and sits in
  the right place. It usually cannot show that it looks right. That needs
  eyes, or a deliberate visual-comparison setup.
- **Accessibility as a whole.** Finding things by role and name gives early
  feedback, but it is not an audit. Whether a flow is usable with a screen
  reader is established by using one.
- **The real environment.** A simulated drop, a fake clipboard or a headless
  window proves the handler works, not that the operating system delivers the
  event the same way.

When a test could not verify something, write that down next to the claim.

## Applying this outside the browser

Every platform has some version of the same ladder:

- An accessibility tree or equivalent (roles, labels, values, states) is rung
  one wherever it exists.
- Visible text, if the harness can read rendered text.
- Stable identifiers the application assigns on purpose are the test hooks.
- Widget hierarchy and layout internals are structure: avoid.

Where the harness is thin, prefer changes that also help real users: giving
an element an accessible label makes it findable by the test and readable by
a screen reader in one move. Reserve test-only registration for elements that
have no user-facing identity at all, keep it out of production builds where
the platform allows, and never let it grow into test-only behaviour.

## Reviewing a UI test

Ask of each test:

1. Could I hand its steps to a person and have them follow along?
2. Does it find each thing by something a user, sighted or not, perceives?
3. Does it act through real input and the application's real entry points?
4. Does it assert what a user would notice, and would it fail if that broke?
5. Would it survive a refactor that changes no behaviour?
6. Does anything in the application exist only so this test can pass?
7. Is every wait for a condition?
8. Does it say what it could not verify?

A "no" to 2 or 6 is usually a finding about the interface, not the test.
