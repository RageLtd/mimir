---
name: unit-testing
description: Writing and reviewing unit tests in any language or framework, meaning fast, in-process tests of one piece of behaviour reached through its public interface. Use whenever you write, change, review or debug a test that runs without a network, a database or another process, when a test broke although the behaviour did not change or passes although the code is wrong, and when code is "hard to test".
---

# Unit testing

A unit test is a programmer's fast check that one piece of behaviour still
holds. Tests are coupled to the behaviour of code and decoupled from its
structure. Everything below follows from that.

## What a unit test is

- **It checks one behaviour through a public interface.** The unit is whatever
  offers that interface: a function, a class, or several closely related
  classes or modules treated as one. It is not "one class" or "one method".
- **It runs in one process and touches nothing slow.** No network, no disk, no
  database, no second process, no sleeping.
- **It is narrow in what it validates, not in what it executes.** The code
  under test will call its real neighbours, and that is fine.

If the behaviour only exists when a real database, file system, network or
second process is present, that is an integration test. If it is about what a
person sees and does on screen, it is a UI test.

## The two ways a test fails you

- **It fails when nothing is broken.** The code was restructured, the
  behaviour is unchanged, and the test goes red. Enough false alarms and a
  team stops reacting to red tests. A test is edited only when the
  requirements change.
- **It passes when something is broken.** It executes the code without
  checking the result that matters, or checks a replacement instead of the
  real thing.

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

- A helper that exists to serve one or two other pieces of code is not a unit.
  Test it through them.
- Something designed to be used by anyone is a unit. Test it directly, the way
  those users would use it.

## What to check

Prefer the highest rung that works, and treat needing a lower one as
information.

1. **The returned value.** Feed inputs, check the output. The implementation
   can be replaced entirely and the test does not notice.
2. **The resulting state, read through the public interface.** Create the
   user, then ask for the user. Never read the state through a private field
   or reflection.
3. **A call the unit made to something else.** This checks how the unit got
   its result, not what the result is, so it is the most likely to break under
   refactoring. It also misses real bugs: the record was written and then
   deleted, and the "write was called" check still passes.

Rung 3 is right in one case: the call is itself the observable result. An
email sent, a message published, a payment requested from a system you do not
control. When you do check a call:

- Check calls that change something. Never check a call that only fetched
  data.
- Check only the arguments this behaviour is about.

Be specific in every assertion: the exact value, not "truthy" or "not empty".
A good failure message states what was wanted, what happened and with which
inputs.

## What to replace

Everything the unit talks to is either real or a stand-in. Prefer the highest
rung that works.

1. **The real thing**, when it is fast, deterministic and simple to construct.
   Values, collections and plain in-process collaborators are always real.
2. **A fake**: a working lightweight implementation, such as an in-memory
   store. Write it once, and hold it to the real thing by running the same
   tests against both.
3. **A stub**: a canned answer, used to put the unit into a state that is hard
   to reach otherwise, such as an error from a dependency. A test that needs
   many of them is over-stubbed, or the unit does too much.
4. **A mock**: a stand-in that checks the calls it received. Use it only for
   rung 3 above.

Use real collaborators and replace only what is awkward. The price is that one
fault can fail many tests; the culprit is in what just changed.

A question settles most cases:

> If this call changed but the result stayed the same, would you want the
> test to fail?

If yes, the call is a contract with something outside: verify it. If no, it is
an implementation detail: use the real collaborator or a fake and check the
result.

## When the code is hard to test

If a behaviour cannot be reached through the public interface, or the test
needs a wall of stand-ins before it can start, the usual cause is the design:
a decision buried inside code that also talks to the outside world, or a
dependency the unit creates for itself instead of being given.

So, in order:

1. Ask whether the decision can be separated from the effect. Gather the
   inputs, compute with code that only reads its parameters, then apply the
   result. The computing part is then testable on rung 1 with no stand-ins.
2. Ask whether the dependency can be passed in.
3. Do not solve it with a back door: making an internal public, adding an
   accessor or a flag that only the test uses, or reaching in by reflection.
   That gives the code a caller that exists only in the test suite.

Do not carve code into interfaces and layers only so that each piece can be
mocked apart. Structure added for the tests alone is complexity every later
reader pays for.

## Writing a test someone can read

Nothing tests the tests, so a test must be obviously correct on reading.

- **Complete and concise.** The body holds everything needed to understand it
  and nothing else. Prefer a little repetition to a helper that hides the
  value the assertion depends on.
- **No logic.** No loops, conditionals or computed expectations. Write the
  expected value out. A test that recomputes the answer the way the code does
  proves nothing.
- **Build test data with helpers that take only what matters.** A helper that
  fills in sensible defaults lets each test state the one or two values it
  cares about.
- **Shared setup builds, it does not decide.** A value that an assertion
  depends on belongs in the test body.
- **Assertion helpers state one fact.** "This user can access this account" is
  a good helper. A catch-all "validate everything" is not.

## Deterministic and alone

- **Same result every run.** Pass in the clock, the random source and anything
  else that varies. Never sleep, and never depend on timing or scheduling.
- **Any order, any subset.** Each test builds what it needs and leaves nothing
  behind. No shared mutable state.
- **A flaky test is a broken test.** Find the cause. Re-running it only delays
  that.

## What to test

- **Whatever you would not want broken.**
- **Failure as well as success.** Bad input, a dependency that errors, the
  empty and boundary cases.
- **Not trivial code.** A plain accessor has nothing to get wrong.

Coverage shows which lines no test ran. It says nothing about whether the
lines that ran were checked, so treat it as a list of gaps, never as a target.

## What a unit test cannot tell you

Say this plainly whenever it applies.

- **That the parts work together.** Each unit can pass alone while the
  contract between two of them is wrong.
- **That a stand-in matches the real thing.** Something must still exercise
  the real one.
- **That the system is fit to ship.**

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
