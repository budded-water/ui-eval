# ADR 0001: Standalone Single-Package Modular Monolith

- Status: Accepted
- Scope: Repository and runtime topology

## Context

UI Eval needs stable boundaries between contracts, project loading, scenario compilation, browser capture, deterministic evaluation, policy gates, storage, reporting, and CLI behavior. It also needs to run locally against independent candidate repositories without importing their application code.

Those boundaries do not currently require separately published packages, services, queues, databases, or deployment units. Splitting them prematurely would introduce version coordination, distribution, network failure, and operational complexity before the contract and evaluator semantics have a compatibility history.

The source repository is public at `https://github.com/budded-water/ui-eval`, but it remains `UNLICENSED` and has no package publication configured. The current execution path is one local Node.js process plus the candidate server and Playwright browser processes it owns or controls.

## Decision

Maintain UI Eval as a standalone, single-package TypeScript modular monolith.

Logical components remain explicit source modules:

```text
contracts
project loader
manifest compiler
capture-playwright
evaluators
policy engine
orchestrator
storage-local
report-html
CLI / public entry point
```

The CLI and root programmatic entry point are composition boundaries. Internal modules use relative imports and narrow interfaces. Candidate repositories own only their authoring inputs and generated `.ui-eval/` working data; they do not copy engine source.

Current and forward-looking capabilities must remain separate. New adapters or service concepts enter the roadmap first and are not represented by empty packages or deployed components.

## Dependency rules

- Contract schemas/types/validation do not depend on capture, storage, reports, or a candidate application.
- Project loading and compilation produce sealed inputs; adapters do not reread floating authoring defaults during capture.
- Capture records evidence and execution facts; it does not make policy decisions.
- Evaluators consume immutable evidence; they do not drive browsers or mutate source.
- The policy engine evaluates restricted expressions; it does not execute arbitrary project code.
- The orchestrator coordinates modules and cross-binds results; the CLI stays thin.
- Storage implementations verify scope/integrity and do not redefine wire semantics.
- Report HTML is a projection of a validated machine report, never an alternate truth source.
- No engine module imports candidate code, aliases, fixtures, environment variables, routes, or business-specific paths.

## Consequences

### Positive

- One install/build/runtime boundary keeps local use and debugging simple.
- Contract and behavior changes can be validated atomically.
- Module seams remain available for future extraction after real reuse proves them.
- No service is required for sensitive local evaluation.
- Browser, storage, and report failures are easier to reason about in one orchestrated lifecycle.

### Negative

- Consumers cannot independently upgrade an adapter or evaluator package.
- The package carries browser, schema, image, and runtime dependencies together.
- Internal boundaries rely on code review and tests rather than separate package visibility.
- A single process contains multiple trust-boundary implementations, so strong OS isolation remains an operator responsibility.

### Risks and mitigations

- **Boundary erosion:** enforce source-module ownership and dependency rules in review/tests.
- **Candidate coupling:** reject candidate imports and prove integration against an independent synthetic project.
- **Documentation overclaim:** keep current capability in architecture/limitations and proposals in roadmap.
- **Future extraction cost:** use narrow interfaces, stable contracts, conformance tests, and avoid internal-path consumers.

## Revisit triggers

Reconsider this decision only when evidence shows that a boundary needs independent ownership or deployment, for example:

- a second implementation of a capture/storage/evaluator interface needs an independent release cadence;
- browser dependencies materially harm ordinary consumer installation;
- untrusted runners require process or network isolation from a control plane;
- a shared team workflow requires queues, RBAC, durable decisions, and remote artifact storage;
- multiple real consumer projects prove a stable plugin API and compatibility matrix.

Crossing a trigger does not automatically authorize a split. A follow-up ADR must define package/service ownership, dependency direction, versioning, migration, security boundary, and release tests.

## Rejected alternatives

### Keep the engine embedded in each candidate repository

Rejected because copied contracts, evaluators, policies, and storage implementations drift and let application-specific assumptions become engine behavior.

### Publish many packages immediately

Rejected because no package distribution or stable compatibility history exists, and independent package versions would multiply unsupported combinations. Public source hosting does not change that compatibility decision.

### Build a hosted control plane first

Rejected because the current local pipeline does not require service infrastructure, and hosted execution would expand security, retention, RBAC, and operations before local value and reuse are proven.

### Collapse all modules into the CLI file

Rejected because contracts, capture, evaluation, storage, and reporting have different responsibilities and test/security boundaries even when they share one package.
