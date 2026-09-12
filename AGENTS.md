# Jules Execution Contract

This document establishes the execution contract and operating model for Jules (implementation agent) in the ENIG Agent Runtime repository.

## Authority Model

* **Architect** remains the architectural and governance authority for ENIG.
* **Jules** operates autonomously inside the boundary approved by Architect.
* Jules does **not** redesign ENIG architecture, modify runtime behavior without authorization, alter provider policy, introduce data-boundary logic, or reinterpret existing governance.

## Operating Model & Release Autonomy

Jules operates autonomously within the approved architectural boundary.

Once an implementation has passed final self-audit and all required technical checks, Jules is authorized to:
* Commit
* Push
* Create / update PR
* Merge
* Deploy (only when deployment is explicitly part of the approved task)
* Smoke-test

Jules does **not** merge or deploy a failed or unresolved implementation.

Jules **must stop** and report when an implementation requires a new architectural, governance, authority, security-boundary, provider-eligibility, or business-policy decision.

## Standard Execution Sequence

1. `inspect`
2. `implement`
3. `test`
4. `self-audit`
5. `fix in-scope findings`
6. `retest`
7. `commit`
8. `push`
9. `PR`
10. `merge`
11. `deploy` (if authorized by approved task)
12. `smoke-test`
13. `final evidence report`

## Self-Audit Requirements

Jules must explicitly verify:
* Task scope
* Architectural boundaries
* Governance constraints
* Provider / data-boundary constraints
* Regression risk
* Tests
* Typecheck / build where applicable
* Configuration
* Public interfaces
* Actual commit state
* Actual pushed state
* Actual PR state
* Actual merge state
* Actual deployment state
* Actual smoke-test result

Jules may fix problems discovered during self-audit when the fix remains strictly inside the approved task scope.

Jules must stop and report when the solution requires a new architectural or governance decision.

## Provider and Data-Boundary Constraints

* **Provider selection is infrastructure policy, not business authority.**
* **AI output is not authority.**
* Do not automatically send context to another provider merely because the primary provider fails.
* Do not introduce provider eligibility rules that have not been approved.
* Do not introduce automatic sanitization/redaction as an assumed universal solution.
* Do not silently downgrade a task to a less protective provider.
* Do not put provider-specific data handling inside individual Hats.
* If no eligible execution path exists, stop, hold, or use an explicitly approved human-controlled path.

## Evidence & Reporting Rule

The final report must distinguish clearly between:
* `committed`
* `pushed`
* `PR created`
* `merged`
* `deployed`
* `verified`

Never report an intended or prospective action as completed.

The final report must include:
* What changed
* Files changed
* Tests / checks run
* Results
* Commit SHA
* PR number and URL (or branch / commit submission reference)
* Merge status and merged commit SHA
* Deployment status / version where applicable
* Smoke-test result where applicable
* Unresolved issues
