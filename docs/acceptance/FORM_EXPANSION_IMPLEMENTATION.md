# Form expansion implementation

This record tracks the eight implementation stages requested on 2026-11-08. Existing scalar contracts and the immutable v0.5 snapshot remain supported. No npm or Marketplace publication is part of this work. Functional checks below are not P0 product validation or power-loss experiments.

| Stage | Scope | Verification |
| --- | --- | --- |
| 1 | Local tarball initializer and standalone starter kit | 10 focused tests / 103 assertions; strict typecheck; extracted standalone kit creates a space-containing app, survives a move, installs with one npm invocation and runs its installed CLI |
| 2 | Separate Node/Bun runtime and package-manager choices | 12 focused tests / 171 assertions; strict typecheck; fresh npm/Bun consumers passed 24 smoke groups; both starter servers passed GET 200, invalid 422 with retained values, valid 303 and receipt 200; Node starter compiled ESM |
| 3 | Shared normalized transport contract | 36 transport/schema/helper/profile tests / 179 assertions; immutable ownership, canonical O(1) lookup, missing defaults and legacy error precedence |
| 4 | Bounded dynamic object rows and stable row identities | Pending |
| 5 | Opt-in streaming multipart and request-owned temporary files | Pending |
| 6 | Rich transport profile and Doctor diagnostics | Pending |
| 7 | Shared native rendering and optional framework state connections | Pending |
| 8 | Captured framework states, editor regression, installable delivery | Pending |

Only completed and executed checks are recorded as passing. Static transport checks do not prove external schema refinements, authorization, business effects, or file contents.
