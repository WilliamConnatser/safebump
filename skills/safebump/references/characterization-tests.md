# Characterization tests before upgrading {{package}} {{fromVersion}} → {{toVersion}}

You are writing tests that pin down what this project's code does **today**, on {{package}} {{fromVersion}}, before anyone upgrades it. They are not tests of {{package}} itself. They exist so the upgrade can't quietly change behavior: they must pass now, and must still pass after the upgrade.

## Sites to cover

From `safebump test-gaps {{package}}@{{toVersion}} --coverage`, highest risk first. Each line is a call into {{package}} that the upgrade is likely to affect, and no test runs it yet:

```
{{riskSites}}
```

## How to write them

1. **Follow the project's conventions.** Use its test runner, file naming and location, helpers and fixtures. Read two or three existing tests first and match them.
2. **One focused test per risk site, or per small group in the same function.** Call the project's own exported function that contains the site (named in the report), not the dependency directly.
3. **Assert on what matters to the upgrade:**
   - **Return values and rendered output:** what the function gives back, or what the component renders.
   - **What the code sends to the dependency.** This catches changed defaults and renamed options. For an API client, assert on the request it builds (method, options, payload fields), e.g. that `store: false` is sent, or that an option the new version renamed is present. For a "default changed" site, assert on the *effective* value today, so the upgrade is forced to keep it explicit.
   - **What the code does with the dependency's results:** error handling, retries, empty cases.
4. **Mock the boundary, not the package.** A test that mocks `{{package}}` itself never runs the code that will change. Mock *beneath* it instead:
   - **Network:** the HTTP layer, with the project's existing approach (msw, nock, undici `MockAgent`, a fetch stub), returning recorded or realistic responses.
   - **Native modules or devices** (React Native, Expo): the native bridge or platform module the project already mocks, not the JS API you're pinning.
   - **Time and randomness:** fake timers and seeded values.

   If mocking below the package is impractical, say so in your report and assert on the call into the package instead, with its full arguments. Never stub the package's functions to return values you choose.
5. **Keep them deterministic and fast.** No real network, no sleeps, and no snapshots of huge objects. Snapshot only small, meaningful shapes.
6. **Don't change production code** to make it testable, unless it's a minimal, behavior-preserving extraction. Flag any such change in your report.

## Prove it

- Run the new tests now: they must pass on {{fromVersion}}.
- Run `safebump test-gaps {{package}}@{{toVersion}} --confirm`. It runs the tests with coverage and checks that every risk site is now executed. Iterate until it passes, or explain the sites you couldn't reach.

## Report

For each risk site: the test that covers it (file and test name) and what it asserts, or why it couldn't be covered. List any production code you touched.
