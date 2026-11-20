---
name: integration-testing
description: Principles for writing and reviewing integration tests in any language, framework or stack, meaning tests of the place where your code meets something it does not contain, such as a database, a file system, a queue, a cache, another service's API, a framework's routing or wiring, or configuration. Use this whenever you write, change, review or debug a test that needs a real database, real files, a real HTTP request, a container, a local server or a stand-in for another service. Use it when deciding whether to run the real dependency or replace it, how to fake or stub a service you do not own and keep that stand-in honest, how to set up and clean up test data, or what belongs in an integration test instead of a unit test or an end-to-end test. Use it when such a test is slow, flaky, order-dependent, or passes although the integration is broken in production. Also use it when briefing someone else to write integration tests. It is about how to think, not about any one tool's API.
---

# Integration testing

An integration test checks a seam: the place where your code hands work to
something it does not contain. Martin Fowler's definition is the whole idea,
and everything below follows from it:

> Integration tests determine if independently developed units of software
> work correctly when they are connected to each other.

## What an integration test is

The term is even less settled than "unit test". Fowler separates two meanings,
and they call for very different tests.

- A **narrow** integration test exercises only the part of your code that
  talks to one outside thing, with that thing either real and local or
  replaced by a stand-in. It is often no bigger than a unit test.
- A **broad** integration test needs live versions of everything and runs
  paths through all of it. That is an end-to-end test under another name.

This document is about the narrow kind. Define it by properties:

- **It is about one seam.** One database, one file format, one queue, one
  remote API, one piece of framework wiring.
- **Something real is on the other side**, or a stand-in that speaks the same
  protocol. This is what a unit test cannot have.
- **It stays on one machine.** It may start processes, open sockets to
  localhost and touch the disk, but it reaches nothing it did not start.

If the behaviour can be checked without the outside thing, it belongs in a
unit test. If it takes the whole deployed system to check, it is an end-to-end
test.

## What only this test can catch

Unit tests replace the far side of every seam, so they are blind to anything
that goes wrong there. Write the integration test for those faults and no
others:

- The query that is well-formed but wrong against the real engine.
- The schema, migration or index the code assumes and the store does not have.
- Data that does not survive the round trip: encodings, dates, precision,
  nulls, field names.
- The response your client cannot parse, or the request the other side
  rejects.
- Transactions, locks and ordering that only exist in the real store.
- Wiring: the route that is not registered, the handler that is never
  reached, the dependency that is not provided.
- Configuration. Google notes that many defects come from configuration, not
  code, and only a test that loads it will notice.
- A stand-in that does not behave like the thing it replaces.

## One seam at a time

Every narrow integration test has the same shape:

1. Start the outside thing, or its stand-in, in a known state.
2. Call your own code at the point where it crosses the seam: the function
   that saves, the client that fetches, the route that receives.
3. Check the outcome at the edge: what can be read back, what the stand-in
   received, what was written.

Enter through the interface your own code offers and assert on results, the
same as in a unit test. Do not reach behind your code to inspect the driver,
the connection or the framework's internals.

## What is real and what is replaced

Decide by who owns the thing on the far side. Vladimir Khorikov's distinction
settles most cases.

1. **What your application owns: use the real thing.** Its database, its
   files, its cache. Nothing else reads them except through your code, so how
   you talk to them is an implementation detail, and a stand-in would only
   pin that detail in place while hiding the faults listed above. Run it
   locally, the same engine and version as production. A lighter engine in
   its place is a different product: Ham Vocke calls testing against one
   "risky business", since the tests then pass against a database you do not
   ship.
2. **What someone else owns: use a stand-in that speaks the real protocol.**
   A local fake server, not a replaced function, so that your real client,
   serialisation and error handling all run. Never call production from a
   test. If the thing cannot be run or faked locally, use a dedicated test
   instance.
3. **Effects that leave your system: capture them.** An email, a published
   message, a call to a payment provider. Other systems depend on that exact
   conversation, so here the call itself is the result. Record what was sent
   and assert on the parts that matter, not on every field.

## Keeping a stand-in honest

A stand-in is a claim about how someone else's system behaves. Unchecked, it
drifts, and the tests go on passing against a system that no longer exists.

- **Contract tests.** Run the same interactions against the stand-in and
  against the real service, and check that the answers have the same shape.
  Compare structure, not exact data.
- **Run them on the other system's rhythm, not yours.** Once a day is often
  plenty. A failure means the stand-in and probably your code need updating,
  and usually a conversation with the other team. It need not block your
  build.
- **Give the provider your expectations.** In a consumer-driven contract, the
  consumer writes down what it relies on and the provider runs that in its
  own build, so a breaking change fails on their side before it ships.
- **Record and replay.** Capture real traffic once and replay it in tests.
  The recording is a snapshot, so something must re-record it and notice
  when it changes.

If nothing checks a stand-in against the real thing, say so next to the test.

## How much to test here

The authors disagree, and it is worth knowing why.

J. B. Rainsberger calls integrated tests a scam. His target is any test whose
result depends on more than one piece of non-trivial behaviour, used to fill
the gaps in unit testing. The paths through combined pieces multiply faster
than anyone can write tests, so each one adds a sliver of coverage and a false
sense of security. His alternative is to check each side of a seam separately:
the client against a stand-in, and the real implementation against the
expectations the client relies on.

Kent C. Dodds says "Write tests. Not too many. Mostly integration." His
argument is that confidence per unit of effort is highest where pieces are
tested together, and that every stand-in removes confidence in the join it
replaces.

They are closer than they sound. Rainsberger later clarified that he meant
integrated, not integration: narrow tests of a seam plus contract tests are
what he recommends. Dodds notes that much of the argument comes from people
defining the words differently. Vocke's advice fits both: push each test as
far down as it will go, and let a higher test cover only what the lower ones
could not.

A question settles most cases:

> What could go wrong here that only the real thing on the other side would
> reveal?

Test that. Every branch and edge case that does not depend on the answer
belongs in a unit test, where it runs in milliseconds and fails for one
reason.

## Test data and state

Most trouble in these tests is state left behind by another test.

- **Start from a known state.** Each test creates what it needs. Nothing
  relies on rows, files or messages that happen to be there.
- **Prefer building fresh to cleaning up.** If setup is wrong, the test that
  fails is the one with the fault. If cleanup is wrong, some later test fails
  instead and the cause is hard to find. Where rebuilding is too slow, run
  each test in a transaction and roll it back, or copy a prepared snapshot.
- **Make data unique per test.** Generated names and ids let tests share one
  store and run in any order without colliding.
- **Seed through the real write path when the path matters.** Writing
  straight to the store is fast, but it skips the checks and triggers the
  application applies, so the state may be one the system could never reach.
- **Make teardown failures loud.** A test that passes and leaves a mess is
  the cause of the next mysterious failure.
- **Own the environment.** A shared database or staging service means other
  people's changes can fail your test.

## Deterministic

Fowler's verdict on a test that sometimes fails is that it is useless, and
worse, infectious: once people shrug at one red test they shrug at all of
them.

- **Wait for a condition, never for a duration.** Poll or listen until the
  thing happens, with a limit. Keep the limits in one place so they can be
  changed together.
- **Control the clock.** Wrap it so a test can set the time and hold it.
- **Release what you acquire.** Leaked connections, handles and ports show up
  as random failures in whichever test happens to hit the limit.
- **Quarantine, then fix.** Move a flaky test out of the main run so the
  healthy ones stay trusted, and cap how many may sit there and for how long.

## Test the seam failing

A seam is where things time out, drop, arrive twice and come back malformed.
A stand-in is the only place those can be produced on demand, so use it: the
slow answer, the error status, the truncated body, the duplicate message, the
connection refused. Check what your code does in each case, not only that it
copes when everything works.

## When the test is hard to write

If a dependency cannot be started locally, or your code cannot be pointed at a
stand-in, the usual cause is not the test tooling. It is the design: an
address fixed in the code instead of read from configuration, or a connection
the code makes for itself instead of being given. Google names the result the
hourglass: many unit tests, many end-to-end tests and little between, because
coupling makes the pieces hard to stand up alone.

Fix that first. Make the address configurable and the dependency something
that is passed in. Do not add a switch that makes the code behave differently
under test, because then the test checks the switch and not the product.

## What an integration test cannot tell you

Say this plainly whenever it applies, instead of implying more than was
proven.

- **That the journey works.** Each seam can pass while the whole path through
  them fails.
- **That the other system behaves this way today.** A test against a stand-in
  proves your code works with the stand-in. Only a contract test or the real
  thing says more.
- **That production matches.** Local containers do not have production's
  configuration, data volume, network or permissions.

## Reviewing an integration test

Ask of each test:

1. Which one seam is it about, and does its name say so?
2. Would a unit test have caught the same fault faster?
3. Is the far side the real thing, or a stand-in that speaks the real
   protocol?
4. If it is a stand-in, what keeps it faithful?
5. Does the test create its own state and pass alone, in any order, beside
   others?
6. Is every wait for a condition?
7. Does it cover the seam failing as well as working?
8. Does it run on a developer's machine with one command and no shared
   environment?

A "no" to 3 or 8 is usually a finding about the design, not the test.

## Sources

Read in November 2026. The principles have been stable for years, but check
the current pages before quoting them.

- Martin Fowler, "Integration Test" (the guiding sentence; narrow and broad),
  "Contract Test" (checking a double against the real service; structure not
  data; the other system's rhythm; consumer-driven contracts),
  "Self Initializing Fake" (record once, replay after) and "Eradicating
  Non-Determinism in Tests" (why a flaky test is useless and infectious;
  quarantine; isolation by rebuilding or rolling back; waiting without
  sleeping; wrapping the clock; resource leaks).
- Ham Vocke, "The Practical Test Pyramid" (one integration point at a time;
  run dependencies locally; the risk of a substitute database; never
  production; contract tests for a fake server; push tests down and do not
  repeat them higher up).
- *Software Engineering at Google*, chapter 11 "Testing Overview" (the
  medium-test constraints; the hourglass) and chapter 14 "Larger Testing"
  (fidelity; unfaithful doubles and configuration as gaps in unit tests;
  seeding data and what direct writes bypass; record and replay; injecting
  failures).
- Vladimir Khorikov, "When to Mock" and "Pragmatic integration testing" (real
  instances of what the application owns; stand-ins only for what it does
  not; capture outgoing effects and check only what matters).
- J. B. Rainsberger, "Beware the Integrated Tests Scam" and "Clearing Up the
  Integrated Tests Scam" (the combinatorial argument; integrated against
  integration; collaboration tests with contract tests).
- Kent C. Dodds, "Write tests. Not too many. Mostly integration." and "The
  Testing Trophy and Testing Classifications" (confidence against cost; what
  a stand-in removes; the argument as a difference of definitions).
