---
name: Test-Driven Development
slug: test-driven-development
description: Enforce RED-GREEN-REFACTOR — write the failing test before any production code.
category: Engineering
requires: [workbench]
license: MIT
default: false
---

Write the test first. Watch it fail. Write the minimal code to pass. Then refactor.

**Core principle:** if you didn't watch the test fail, you don't know that it tests the right thing.

## The Iron Law
```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```
Wrote code before the test? Delete it and reimplement from the test. "Keep it as reference" is just testing-after in disguise.

**Always TDD:** new features, bug fixes, refactors, behavior changes.
**Ask first before skipping:** throwaway prototypes, generated code, config files. "Skip it just this once" is rationalization — stop.

## Red-Green-Refactor
**RED — write one failing test.** One behavior per test. A clear name that describes behavior ("and" in the name? split it). Exercise real code, not mocks, unless truly unavoidable.

**Verify RED (mandatory).** Run *just that test* with the `verify.run` tool (or `shell.exec`). Confirm it fails because the feature is *missing*, not from a typo. Passes immediately? You're testing existing behavior — fix the test.

**GREEN — minimal code to pass.** The simplest thing that works, nothing extra. Cheating is fine here: hardcode, copy-paste, skip edge cases. No logging, no "while I'm here" features.

**Verify GREEN (mandatory).** Run the test (passes), then run the **whole suite** to catch regressions. Test fails? Fix the *code*, not the test. Other tests fail? Fix the regression now.

**REFACTOR — clean up, green throughout.** Remove duplication, improve names, extract helpers. Add no behavior. A test goes red during refactor → undo immediately, take smaller steps.

**Repeat** with the next failing test for the next behavior. One cycle at a time.

## Vertical slices, not horizontal
Do NOT write all tests then all code. Go one tracer bullet at a time: test1→impl1, test2→impl2. Each passing slice teaches you the interface before you design the next test.

## Common rationalizations (all mean: start over with TDD)
- "I'll test after" → tests written after pass immediately and prove nothing.
- "Already manually tested" → ad-hoc ≠ systematic; no record, can't re-run.
- "Deleting hours of work is wasteful" → sunk cost; keeping unverified code is the real debt.
- "Too simple to test" → simple code still breaks; the test costs 30 seconds.
- "Hard to test" → listen to it: hard to test = hard to use. Simplify the design.

## Bugs
Never fix a bug without first writing a failing test that reproduces it. The test proves the fix and prevents the regression.

## Done means
Every new function has a test, you watched each one fail for the right reason, you wrote minimal code to pass, the full suite is green, and the output is pristine (no stray warnings). Can't check all of those? You skipped TDD — start over.

*Uses Agent OS's `verify.run` / `shell.exec` (the WORKBENCH capability) to run tests.*
