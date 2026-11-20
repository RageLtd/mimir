---
name: end-to-end-testing
description: Principles for writing and reviewing end-to-end tests in any language, framework or stack, meaning tests that run the whole assembled system and drive it from outside the way a real user or client does, through a browser, an app window, a public API, a command line or a message sent in. Use this whenever you write, change, review or debug an end-to-end, system, smoke, acceptance or user-journey test, or decide whether one should exist. Use it when choosing which journeys deserve such a test, where the test environment and its data come from, what to do about third-party services, how to log in and set up state, or whether to go through the interface or just beneath it. Use it when the suite is slow, flaky or ignored, when a failure does not say what broke, or when someone proposes covering an edge case or a bug fix with another end-to-end test. Also use it when briefing someone else to write these tests. For how to find, act on and assert against a user interface, use the ui-testing skill alongside this one. It is about how to think, not about any one tool's API.
---

# End-to-end testing

An end-to-end test runs the whole system, connected as it ships, and checks
that someone can still get one thing done with it. Martin Fowler says where
such tests stand, and everything below follows from it:

> I always argue that high-level tests are there as a second line of test
> defense.

They are the second line, not the first: few, broad, and aimed at what no
smaller test can see.

## What an end-to-end test is

Define it by properties, not by the name or the tool.

- **The whole system is running**, built and configured the way it is
  deployed, with its real parts talking to each other.
- **It is driven from outside**, through the interface a real user or client
  uses. That may be a screen, but a public API or a command line is as much a
  user interface as a web page. For a batch system it is a transaction fed in
  at one end and a result checked at the other.
- **It follows one goal from start to finish**: a person signs up, a client
  places an order, a file goes in and a report comes out.

Fowler calls the boundary a continuum. A test may stop short of the full stack
in two places and still be end-to-end: just under the interface, and at
systems you do not own. Both are choices to make on purpose, covered below.

Three things are often confused and are separate. End-to-end is about how
much of the system runs. A UI test is about driving an interface, which can be
done against one component. An acceptance test is about whether a feature
does what was asked, which can be checked at any level. A test may be one,
two or all three.

When the test drives a user interface, how it finds things, acts and asserts
is the subject of the UI testing skill. This document is about which tests to
have, what they run against and how to keep them trustworthy.

## What only this test can tell you

Smaller tests check the parts and the seams. Only this one checks the
assembly:

- The system starts at all from the artifact and configuration that will ship.
  A test that only brings it up and sees it answer is already worth having.
- The parts are wired to each other correctly: addresses, credentials,
  versions, permissions.
- A request survives the whole path: through routing, sign-in, each service
  and the store, and back.
- The steps work in sequence, each using what the one before left behind.

Google's description is that these tests are more about validating
configuration than pieces of code, and should not be the primary way of
catching bugs.

## Which journeys earn a test

Very few. Each test here costs more to run, more to maintain and more to
diagnose than any other kind.

- **Pick the journeys that are the product.** Ham Vocke's example for a shop
  is search, add to basket, check out. If that works, you are not in too much
  trouble. One or two more, and beyond that the tests hurt more than they
  help.
- **One path per goal, usually the successful one.** Every variation belongs
  to smaller tests.
- **No edge cases.** Validation messages, empty lists and error handling were
  checked lower down. Do not check them again here.
- **A new feature rarely means a new journey.** Fowler's advice is to look at
  the journeys you have and change them to include the new behaviour.
- **A bug found here is two bugs.** The code is wrong and a smaller test is
  missing. Reproduce it in a smaller test first, then fix it. Do not add an
  end-to-end test per bug.

A question settles most cases:

> If this stopped working in production tonight, would someone be woken up?

If yes, it is a journey. If no, a smaller test should hold it.

## How many is too many

The authors disagree, and it is worth knowing why.

Fowler, Vocke and Google all say few. Tests through the whole system are slow,
break for reasons unrelated to what they check, and fail without saying where.
Google's rough guide is about 5% of tests.

Adrian Sutton describes the opposite at LMAX: 10,000 end-to-end acceptance
tests, run constantly, finishing in about 50 minutes, every one required to
pass before a release. He calls them "massively, indisputably worth it",
because they let the team restructure components freely.

The two agree on more than it seems. LMAX paid for what makes that possible:
tests isolated well enough to run in parallel across a pool of servers,
ownership by the whole team, and no tolerance for a test that sometimes
fails. Fowler's own footnote to the pyramid says that if high-level tests are
fast, reliable and cheap to change, lower-level ones are not needed. The
pyramid is a statement about cost. Until that cost has been paid, keep them
few.

## What is real

- **Everything you own is real** and deployed as it will be in production.
  Replacing one of your own parts makes this a test of something that never
  ships.
- **Do not drive what you do not control.** A third party's sign-in page,
  payment form or site will change, throttle you, or decide you are a robot.
  Stand in for it at the boundary and keep the stand-in honest with contract
  tests.
- **Say which parts were stood in.** "End-to-end" claims the whole path. If
  the payment provider was a stand-in, the claim stops there.

## Where to enter

Enter where the real user or client enters. That is what makes the test
predictive.

Going in just beneath the interface is a fair trade when the interface is
hard to drive or slow: the test is quicker and steadier and still covers most
of the stack. Fowler names the danger: any behaviour that lives in the
interface is then untested. Make the trade knowingly, keep at least one
journey that goes through the real interface, and say which tests do not.

## The environment

The system under test is the largest source of slowness and false failures.

- **Prefer one the test owns.** A private instance started for the run cannot
  be changed or dirtied by anyone else. Google's finding is that the easiest
  and most stable large tests are those whose whole system fits on the
  machines that run the ordinary build.
- **A shared staging environment is a compromise.** Other people's deploys
  and data will fail your tests, and yours theirs.
- **Production is too late to gate a release.** A test there cannot stop the
  code that is already there. It has a different job, described below.
- **Make it as small as it can be while still faithful.** Each extra machine
  and network hop adds ways to fail that are not bugs.

## State and data

- **Each test stands alone.** It passes when run by itself, in any order, and
  beside others. A test that needs the one before it fails for reasons
  unrelated to what it checks.
- **Each test makes its own data, with its own identity.** A fresh account or
  record per run, named so it is recognisable as test data, lets tests run
  side by side without colliding.
- **Set up the fast way, exercise the real way.** Create the account and sign
  in through an API or by seeding, then drive only the journey under test.
  One journey proves sign-in through the interface; the rest should not
  repeat it.
- **Seed with care.** Writing straight into a store skips the checks the
  system applies on the way in, so the state may be one no user could reach.
- **Reset before, not after.** Cleanup at the end does not run when a test is
  interrupted, and the next run inherits the mess. Cleaning first always
  runs, and leaves the failed state in place to look at.

## The shape of a journey test

Write the journey first as the instructions you would give a person, then
turn it into the test step for step.

Several assertions along the way are right: each step is expensive to reach,
and checking as you go shows where the journey stopped. The limit is a single
test that walks everything and reports one failure under one vague title.
Label the steps, so the failure names the step and not only the journey.

## Flakiness

A journey crosses every source of nondeterminism the system has, so this is
where flaky tests gather. Google reported that about 84% of the changes from
pass to fail it observed involved a flaky test, and that real failures were
often dismissed because of it.

- **Wait for a condition, never for a duration.**
- **Never accept "mostly passes".** Sutton's account of LMAX is that
  tolerating some failures per run was a death-knell: new intermittent tests
  hide among the old ones and the number only grows.
- **A retry is not a fix.** Re-running until green keeps the pipeline moving
  and only delays finding the cause.
- **Quarantine with a record.** Move a flaky test out of the gating run, file
  it, and fix it or delete it. Google's caution is that a quarantined test
  may be hiding a real race in the product, so it cannot stay there.

## When it fails

An end-to-end failure says that something is broken, not what. Plan for that
before it happens.

- **Capture evidence at the moment of failure**: a trace of the steps, what
  was on screen, the requests made, and the logs of every part.
- **Write failure messages for someone who does not know the code**: which
  journey, which step, what was expected and what was found.
- **Give each test an owner.** A test that crosses many teams' code belongs
  to no one by default, and Google's observation is that such a test rots.

## After release

The same few journeys can run against production on a schedule, with failures
sent to monitoring. That catches what no earlier environment has: the exact
mix of versions and configuration that is live. Mark the traffic as synthetic
so it stays out of analytics and real records, use accounts that are
recognisably test accounts, and have each run clean up its own state first.

## What an end-to-end test cannot tell you

Say this plainly whenever it applies, instead of implying more than was
proven.

- **That anything off the tested path works.** One successful journey says
  nothing about its variations.
- **Where the fault is.**
- **That it is pleasant, clear or usable.** Vocke's point is that usability
  and "looks good" are outside automation; they need a person exploring the
  running system.
- **That production behaves the same**, unless the test ran there.
- **Anything about a part that was stood in.**

## Reviewing an end-to-end test

Ask of each test:

1. Is this a journey someone would be woken for, and is there only one test
   of it?
2. Could a smaller test have held the same thing?
3. Is every part you own real and deployed as it ships, and is every stand-in
   named?
4. Does it enter where the user enters, or say that it does not?
5. Does it make its own data and pass alone, in any order, beside others?
6. Is every wait for a condition, and does it pass every time?
7. When it fails, will the report say which step, with enough evidence to
   start?
8. Does someone own it?

A "no" to 1 or 2 means the test should move down or go.

## Sources

Read in November 2026. The principles have been stable for years, but check
the current pages before quoting them.

- Martin Fowler, "Test Pyramid" (the guiding sentence; replicate a high-level
  failure in a lower test first; end-to-end, UI and customer-facing as
  separate things; the footnote on fast and reliable high-level tests),
  "Broad Stack Test" (the continuum; stopping short under the interface and
  at remote systems), "User Journey Test" (one path per use case; change
  journeys, rarely add them), "Subcutaneous Test" (the trade and its danger)
  and "Synthetic Monitoring" (journeys run against production; marking test
  traffic and accounts).
- Ham Vocke, "The Practical Test Pyramid" (the bare minimum of journeys; an
  API or command line as a user interface; no repeating lower tests; delete
  tests that add nothing; exploratory testing for what automation cannot
  judge).
- *Software Engineering at Google*, chapter 11 "Testing Overview" (the share
  of end-to-end tests; large tests as configuration checks, not the primary
  way to find bugs) and chapter 14 "Larger Testing" (hermetic against shared
  environments; production tests come too late to gate; seeding; failure
  messages; ownership).
- Google Testing Blog, "Flaky Tests at Google and How We Mitigate Them" (the
  share of failures that involve a flaky test; retries and quarantine, and
  what they can mask).
- Adrian Sutton, "Making End-to-End Tests Work" (the LMAX suite; what it took;
  intermittency as the thing that kills a suite).
- Cypress, "Best Practices", and Playwright, "Best Practices" (only test what
  you control; independent tests; sign in and set up state programmatically;
  reset state before a test, not after; several assertions per test and the
  limit of that; traces for failures in CI).
