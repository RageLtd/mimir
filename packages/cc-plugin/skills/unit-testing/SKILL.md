---
name: unit-testing
description: Principles for writing and reviewing unit tests in any language or test framework, meaning fast, in-process tests of one piece of behaviour reached through its public interface. Use this whenever you write, change, review or debug a test of a function, class, module or package that runs without a network, a database or another process. Use it when deciding what counts as the unit, what to assert, whether to use the real collaborator or a fake, stub or mock, how to name and lay out a test, or how much setup to share. Use it when a test broke although the behaviour did not change, when a test passes although the code is wrong, when a test is flaky or slow, or when code is "hard to test" and the fix on offer is to expose an internal or mock everything around it. Also use it when briefing someone else to write unit tests. It is about how to think, not about any one framework's API.
---

# Unit testing

A unit test is a programmer's fast check that one piece of behaviour still
holds. Kent Beck puts the whole idea in one sentence, and everything below
follows from it:

> Tests should be coupled to the behavior of code and decoupled from the
> structure of code.

## What a unit test is

The word has no agreed definition. Martin Fowler recalls a testing expert who
covered 24 of them in a morning. So define it by properties, not by the name.

- **It checks one behaviour through a public interface.** The unit is whatever
  offers that interface: a function, a class, or several closely related
  classes or modules treated as one. It is not "one class" or "one method".
- **It runs in one process and touches nothing slow.** No network, no disk, no
  database, no second process, no sleeping. Google calls this a small test and
  enforces it, because those are the main sources of slowness and of results
  that change from run to run.
- **It is narrow in what it validates, not in what it executes.** The code
  under test will call its real neighbours, and that is fine. The test is
  about one behaviour; the rest is assumed to work.

If the behaviour only exists when a real database, file system, network or
second process is present, a unit test cannot hold it: that is an integration
test. If it is about what a person sees and does on screen, it is a UI test.

## The two ways a test fails you

A test is worth having only if its result means something. There are two ways
it stops meaning something, and most of this document is about avoiding both.

- **It fails when nothing is broken.** The code was restructured, the
  behaviour is unchanged, and the test goes red. Enough false alarms and a
  team stops reacting to red tests at all. Google's standard is that the ideal
  test is unchanging: it is edited only when the requirements change.
- **It passes when something is broken.** It executes the code without
  checking the result that matters, or checks a replacement instead of the
  real thing.

Vladimir Khorikov's four pillars name what you are balancing: protection
against regressions, resistance to refactoring, fast feedback and
maintainability. They pull against each other, so every test is a trade. Beck's
rule for the trade: give no property up without getting one of greater value
in return.

## Start from the behaviour

Before writing code, write the behaviours as sentences a user of the unit
would recognise: "a transfer larger than the balance is refused and both
balances are unchanged". Each sentence becomes one test.

- **One test per behaviour, not per method.** A method with three behaviours
  gets three tests. A behaviour that takes three calls gets one.
- **Name the test after the behaviour**, so the name alone tells a reader what
  broke.
- **Lay it out as given, when, then**: the setup, the one action, the check.
  Keep the three visibly apart.

If a sentence cannot be written without naming something internal ("the cache
map has two entries"), ask what a caller would observe. That is the assertion.

## Enter through the public interface

Call the unit the way its real callers do. A test that calls a private helper
or reads an internal field breaks on every rename and extraction, although no
caller could tell the difference.

Google's guide to where the interface is:

- A helper that exists to serve one or two other pieces of code is not a unit.
  Test it through them.
- Something designed to be used by anyone without asking its owners is a unit.
  Test it directly, the way those users would use it.
- A support library used in many places is a unit too, even though its users'
  tests will also exercise it.

## What to check

Prefer the highest rung that works, and treat needing a lower one as
information.

1. **The returned value.** Feed inputs, check the output. This is the most
   stable thing about a unit: the implementation can be replaced entirely and
   the test does not notice.
2. **The resulting state, read through the public interface.** Create the
   user, then ask for the user. Never read the state through a private field
   or reflection.
3. **A call the unit made to something else.** This checks how the unit got
   its result, not what the result is, so it is the most likely to break under
   refactoring. It also misses real bugs: the record was written and then
   deleted, and the "write was called" check still passes.

Rung 3 is right in one case: the call is itself the observable result. An
email sent, a message published, a payment requested from a system you do not
control. No state exists for you to read back, and other systems depend on
that exact conversation. When you do check a call:

- Check calls that change something. Never check a call that only fetched
  data. If you set up a canned answer for it, that is the sign it needs no
  verification.
- Check only the arguments this behaviour is about. Asserting every argument
  and every incidental call makes the test fail for unrelated changes.

Be specific in every assertion: the exact value, not "truthy" or "not empty".
A good failure message states what was wanted, what happened and with which
inputs, so the failure can be diagnosed without opening the test.

## What to replace

Everything the unit talks to is either real or a stand-in. Prefer the highest
rung that works.

1. **The real thing**, when it is fast, deterministic and simple to construct.
   Values, collections, and plain in-process collaborators are always real.
2. **A fake**: a working lightweight implementation, such as an in-memory
   store. The unit cannot tell it from the real one, so the test still checks
   results. A fake is only as good as its fidelity. It should be written once,
   at the lowest layer that cannot be used in tests, kept by whoever owns the
   real thing, and held to it by running the same tests against both.
3. **A stub**: a canned answer, used to put the unit into a state that is hard
   to reach otherwise, such as an error from a dependency. Every stubbed
   answer should bear directly on the assertion. A test that needs many of
   them is over-stubbed, or the unit does too much.
4. **A mock**: a stand-in that checks the calls it received. Use it only for
   rung 3 above.

The authors disagree here, and it is worth knowing why. The mockist school
replaces every collaborator, so a bug fails only the tests of the unit that
contains it, and writing the test first drives out the collaborators' roles.
The classical school uses real collaborators and replaces only what is awkward,
so tests survive restructuring and catch faults where units meet. Fowler,
Google and Khorikov all take the classical side: Fowler because mockist tests
couple to implementation, Google under the heading "Prefer Realism Over
Isolation". The price is that one fault can fail many tests. In practice the
culprit is easy to spot if tests are run often, because it is in what just
changed.

A question settles most cases:

> If this call changed but the result stayed the same, would you want the
> test to fail?

If yes, the call is a contract with something outside: verify it. If no, it is
an implementation detail: use the real collaborator or a fake and check the
result.

## When the code is hard to test

This is the most valuable moment in unit testing, and the easiest to waste.

If a behaviour cannot be reached through the public interface, or the test
needs a wall of stand-ins before it can start, the usual cause is not a weak
test tool. It is the design: a decision buried inside code that also talks to
the outside world, or a dependency the unit creates for itself instead of
being given.

So, in order:

1. Ask whether the decision can be separated from the effect. Gather the
   inputs, compute with code that only reads its parameters, then apply the
   result. The computing part is then testable on rung 1 with no stand-ins.
2. Ask whether the dependency can be passed in. Code that is handed its
   collaborators can be handed a fake.
3. Do not solve it with a back door: making an internal public, adding an
   accessor or a flag that only the test uses, or reaching in by reflection.
   That gives the code a caller that exists only in the test suite.

One caution in the other direction: do not carve code into interfaces and
layers only so that each piece can be mocked apart. Structure added for the
tests alone is complexity every later reader pays for.

## Writing a test someone can read

Nothing tests the tests, so a test must be obviously correct on reading.

- **Complete and concise.** The body holds everything needed to understand it
  and nothing else. Prefer a little repetition to a helper that hides the
  value the assertion depends on.
- **No logic.** No loops, conditionals or computed expectations. Write the
  expected value out. Logic in a test is untested code, and a test that
  recomputes the answer the way the code does proves nothing.
- **Build test data with helpers that take only what matters.** A helper that
  fills in sensible defaults lets each test state the one or two values it
  cares about. Shared constants with vague names do the opposite.
- **Shared setup builds, it does not decide.** Use it to construct the unit
  and its collaborators. A value that an assertion depends on belongs in the
  test body.
- **Assertion helpers state one fact.** "This user can access this account" is
  a good helper. A catch-all "validate everything" run at the end of every
  test is not.

## Deterministic and alone

- **Same result every run.** Pass in the clock, the random source and anything
  else that varies. Never sleep, and never depend on timing or scheduling.
- **Any order, any subset.** Each test builds what it needs and leaves nothing
  behind. No test reads what another wrote, and no shared mutable state.
- **A flaky test is a broken test.** Find the cause. Re-running it only delays
  that. Google's experience is that tests begin to lose their value as a suite
  approaches 1% flaky, because people stop trusting a red result.

## What to test

- **Whatever you would not want broken.** If a behaviour matters, only a test
  keeps it.
- **Failure as well as success.** Bad input, a dependency that errors, the
  empty and boundary cases.
- **Not trivial code.** A plain accessor has nothing to get wrong, and a test
  of it only adds weight.

Coverage shows which lines no test ran. It says nothing about whether the
lines that ran were checked, so treat it as a list of gaps, never as a target.

## What a unit test cannot tell you

Say this plainly whenever it applies, instead of implying more than was
proven.

- **That the parts work together.** Each unit can pass alone while the
  contract between two of them is wrong.
- **That a stand-in matches the real thing.** A test against a fake or a stub
  proves the unit works with that fake or stub. Something must still exercise
  the real one.
- **That the system is fit to ship.** Beck's own description of programmer
  tests is that they give up being predictive of production in exchange for
  being cheap to write, fast and specific about what failed.

## Reviewing a unit test

Ask of each test:

1. Does its name say which behaviour broke?
2. Does it enter through the interface real callers use?
3. Does it check a result, and would it fail if that result were wrong?
4. Would it survive a refactor that changes no behaviour?
5. Is every stand-in needed, and is every verified call one that something
   outside depends on?
6. Can it be understood without reading another file, and is it free of
   logic?
7. Does it give the same result alone, in any order, on any machine?
8. Does anything in the code exist only so this test can pass?

A "no" to 2 or 8 is usually a finding about the design, not the test.

## Sources

Read in November 2026. The principles have been stable for years, but check
the current pages before quoting them.

- Kent Beck, "Test Desiderata" (the guiding sentence; the twelve properties;
  giving none up without a better one in return; programmer tests trade
  predictive for writable, fast and specific).
- *Software Engineering at Google*, chapter 11 "Testing Overview" (test size
  against test scope; the small-test constraints; hermetic tests; the cost of
  flakiness; coverage as a limited signal), chapter 12 "Unit Testing"
  (unchanging tests; test via public APIs and what counts as a unit; state
  over interactions; behaviours, not methods; complete and concise; no logic;
  failure messages; DAMP, shared values, setup and helpers) and chapter 13
  "Test Doubles" (prefer real implementations; fakes and their fidelity; the
  limits of stubbing; when interaction testing is appropriate and how to keep
  it from overspecifying).
- Martin Fowler, "Unit Test" (no single definition; the unit is situational;
  solitary and sociable tests) and "Mocks Aren't Stubs" (the kinds of test
  double; state and behaviour verification; the classical and mockist schools
  and what each costs).
- Vladimir Khorikov, "Unit tests value proposition", "Styles of unit testing"
  and "When to Mock" (the pillars and why they trade off; output, state and
  collaboration checks ranked by false alarms; mock only communication that
  systems outside your control can observe; skip trivial code).
