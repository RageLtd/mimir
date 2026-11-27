---
name: end-to-end-testing
description: Writing and reviewing end-to-end tests in any stack, meaning tests that run the whole assembled system and drive it from outside the way a real user or client does. Use whenever you write, change, review or debug an end-to-end, system, smoke, acceptance or user-journey test, decide whether one should exist, or face a suite that is slow, flaky or ignored. For how to find, act on and assert against a user interface, use the ui-testing skill alongside this one.
---

# End-to-end testing

An end-to-end test runs the whole system, connected as it ships, and checks
that someone can still get one thing done with it. These tests are the second
line of defence, not the first: few, broad, and aimed at what no smaller test
can see.

## What an end-to-end test is

- **The whole system is running**, built and configured the way it is
  deployed, with its real parts talking to each other.
- **It is driven from outside**, through the interface a real user or client
  uses. A public API or a command line is as much a user interface as a web
  page. For a batch system it is a transaction fed in at one end and a result
  checked at the other.
- **It follows one goal from start to finish**: a person signs up, a client
  places an order, a file goes in and a report comes out.

A test may stop short of the full stack in two places and still be
end-to-end: just under the interface, and at systems you do not own. Both are
choices to make on purpose, covered below.

Three things are often confused. End-to-end is about how much of the system
runs. A UI test is about driving an interface, which can be done against one
component. An acceptance test is about whether a feature does what was asked,
which can be checked at any level.

## What only this test can tell you

- The system starts at all from the artifact and configuration that will ship.
  A test that only brings it up and sees it answer is already worth having.
- The parts are wired to each other correctly: addresses, credentials,
  versions, permissions.
- A request survives the whole path: through routing, sign-in, each service
  and the store, and back.
- The steps work in sequence, each using what the one before left behind.

These tests validate configuration and assembly. They are not the primary way
of catching bugs.

## Which journeys earn a test

Very few. Each test here costs more to run, maintain and diagnose than any
other kind.

- **Pick the journeys that are the product.** For a shop: search, add to
  basket, check out. One or two more, and beyond that the tests hurt more
  than they help.
- **One path per goal, usually the successful one.** Every variation belongs
  to smaller tests.
- **No edge cases.** Validation messages, empty lists and error handling were
  checked lower down.
- **A new feature rarely means a new journey.** Change a journey you have to
  include the new behaviour.
- **A bug found here is two bugs.** The code is wrong and a smaller test is
  missing. Reproduce it in a smaller test first, then fix it. Do not add an
  end-to-end test per bug.

A question settles most cases:

> If this stopped working in production tonight, would someone be woken up?

If yes, it is a journey. If no, a smaller test should hold it.

A large end-to-end suite only pays once its tests are isolated well enough to
run in parallel, owned by the whole team, and never allowed to fail
intermittently. Until that cost has been paid, keep them few.

## What is real

- **Everything you own is real** and deployed as it will be in production.
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
hard to drive or slow. Any behaviour that lives in the interface is then
untested. Make the trade knowingly, keep at least one journey that goes
through the real interface, and say which tests do not.

## The environment

- **Prefer one the test owns.** A private instance started for the run cannot
  be changed or dirtied by anyone else.
- **A shared staging environment is a compromise.** Other people's deploys
  and data will fail your tests, and yours theirs.
- **Production is too late to gate a release.**
- **Make it as small as it can be while still faithful.** Each extra machine
  and network hop adds ways to fail that are not bugs.

## State and data

- **Each test stands alone.** It passes when run by itself, in any order, and
  beside others.
- **Each test makes its own data, with its own identity.** A fresh account or
  record per run, named so it is recognisable as test data.
- **Set up the fast way, exercise the real way.** Create the account and sign
  in through an API or by seeding, then drive only the journey under test.
  One journey proves sign-in through the interface; the rest should not
  repeat it.
- **Seed with care.** Writing straight into a store skips the checks the
  system applies on the way in, so the state may be one no user could reach.
- **Reset before, not after.** Cleanup at the end does not run when a test is
  interrupted. Cleaning first always runs, and leaves the failed state in
  place to look at.

## The shape of a journey test

Write the journey first as the instructions you would give a person, then
turn it into the test step for step.

Several assertions along the way are right: each step is expensive to reach,
and checking as you go shows where the journey stopped. Label the steps, so
the failure names the step and not only the journey.

## Flakiness

A journey crosses every source of nondeterminism the system has.

- **Wait for a condition, never for a duration.**
- **Never accept "mostly passes".** New intermittent tests hide among the old
  ones and the number only grows.
- **A retry is not a fix.** Re-running until green only delays finding the
  cause.
- **Quarantine with a record.** Move a flaky test out of the gating run, file
  it, and fix it or delete it. It may be hiding a real race in the product,
  so it cannot stay there.

## When it fails

An end-to-end failure says that something is broken, not what.

- **Capture evidence at the moment of failure**: a trace of the steps, what
  was on screen, the requests made, and the logs of every part.
- **Write failure messages for someone who does not know the code**: which
  journey, which step, what was expected and what was found.
- **Give each test an owner.** A test that crosses many teams' code belongs
  to no one by default, and rots.

## After release

The same few journeys can run against production on a schedule, with failures
sent to monitoring. Mark the traffic as synthetic so it stays out of
analytics and real records, use accounts that are recognisably test accounts,
and have each run clean up its own state first.

## What an end-to-end test cannot tell you

Say this plainly whenever it applies.

- **That anything off the tested path works.**
- **Where the fault is.**
- **That it is pleasant, clear or usable.** That needs a person exploring the
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
