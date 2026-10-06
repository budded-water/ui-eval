# Local and Remote Evaluation

Both modes use the same compiler, capture adapter, deterministic evaluators and
policy gates. Profiles change the target and lifecycle, not passing semantics.
Profiles and suites are reviewed project configuration. No hosted runner,
deployment service or model call is introduced.

## Configure profiles

Add this fragment to a complete `ui-eval/project.json`, retaining `devServer`.
References must exist in `baseUrls`; these URLs are synthetic placeholders.

```json
{
  "baseUrls": {
    "local": "http://127.0.0.1:3000",
    "preview": "https://preview.example.invalid",
    "api": "https://api.example.invalid"
  },
  "executionProfiles": {
    "local": { "mode": "local", "baseUrlRef": "local" },
    "preview": {
      "mode": "remote",
      "baseUrlRef": "preview",
      "frontend": { "identityPath": "/version" },
      "backend": {
        "baseUrlRef": "api",
        "identityPath": "/version",
        "expected": { "revision": "backend-v2", "apiContractVersion": "v2" }
      },
      "readinessTimeoutMs": 30000
    }
  }
}
```

An explicitly selected profile replaces the scenario's base URL reference and
seals the resolved target in its plan. Local profiles must share the development
server's origin and keep existing lifecycle behavior. Omitting a profile
preserves earlier local behavior and report shape.

Remote profiles require a clean Git checkout. The frontend endpoint must report
the checkout's exact commit SHA, which cannot be overridden in configuration.
Optional frontend expectations can pin API contract, feature-flag digest and
data revision. An optional backend endpoint pins its revision and can pin those
same fields. Unspecified fields are not verified or retained as verified facts.

Endpoints return JSON matching
[deployment-identity.schema.json](../schemas/deployment-identity.schema.json):

```json
{
  "schemaVersion": "uieval.deployment/v1alpha1",
  "revision": "backend-v2",
  "apiContractVersion": "v2"
}
```

The frontend uses its actual commit SHA instead of this backend example value.
Versions are bounded, non-secret identifiers. Identity requests use explicit,
credential-free HTTP(S) URLs; browser storage state is never attached. Paths
cannot contain queries, fragments, backslashes or protocol-relative destinations.
Redirects are refused; response bodies are limited to 64 KiB. Raw bodies are
never persisted or included in diagnostics.

Before each variant, the orchestrator polls both configured identities within
the declared deadline (at most 60 seconds), cancelling unfinished requests
between attempts. After capture it verifies them again without readiness
retries. Mismatch, timeout, malformed response or dirty checkout produces an
infrastructure/inconclusive report and cannot authorize product repair.
Remote runs never acquire the local development server and refuse local
mock-server fixtures. They still own and clean up their browser resources.

```bash
ui-eval doctor --execution-profile preview --project-root /path/to/candidate
ui-eval evaluate home --execution-profile local --project-root /path/to/candidate
ui-eval evaluate home --execution-profile preview --project-root /path/to/candidate
```

`doctor` checks identities immediately; `evaluate` waits for readiness.
Infrastructure failures retain exit `2`. JSON/HTML reports carry the selected
target and verification status; reproduction commands retain the profile.

## Bounded model decisions

Use a small local suite for iteration and a reviewed remote suite for integration.
A suite can pin `executionProfile`; CLI overrides cannot replace it with another
profile. `scenarios` is the mandatory floor. `optionalScenarios` is a reviewed
pool of extra configurations, with unique IDs across both lists.

An external model may assess a diff and propose IDs via repeated
`--additional-scenario` flags or API `additionalScenarios`. The engine appends
declared IDs only, rejects unknown IDs and deduplicates suggestions. The model
cannot remove required checks or redefine scenarios, dimensions, references,
thresholds or policy gates through this interface. Every selected scenario must
pass, including additions. `--full-scope` (API `fullScope`) selects the whole
pool when impact is uncertain. The engine does not infer uncertainty or select
affected scenarios itself.

```bash
ui-eval agent local-smoke --additional-scenario details --project-root /path/to/candidate
ui-eval agent preview-integration --full-scope --project-root /path/to/candidate
```

Canonical `summary.json` and derived `summary.html` record required/selected
scenario IDs and the selected profile. Acceptance applies only to that scope;
local acceptance does not establish remote integration readiness. Remote suites
reject explicit `--repair` and disable implicit repair. Infrastructure retries
re-capture all selected remote scenarios rather than reuse earlier evidence.

## Deployment identity has two ledgers

The clean checkout is canonical for expected frontend revision; reviewed project
configuration is canonical for backend and additional expectations. The candidate
build/deployment pipeline owns served metadata and must publish it from the
actual deployed artifact. Divergence blocks evaluation instead of changing the
expectation to whatever happens to be online.

Endpoint assertions are not signed artifact attestation or an environment lock.
Pre/post matching cannot prove constant identity throughout capture or that the
browser used the configured backend. Project checks must prove real API/data
flows. Browser origin/auth egress restrictions still apply; metadata checks do
not authorize browser cross-origin traffic. Use isolated preview/staging with
reviewed scenarios; remote mode does not make mutating production workflows safe.
