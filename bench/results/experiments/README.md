# Parity Experiment Manifests

## Purpose

Each JSON file is the immutable execution contract for one parity experiment. It fixes the hypothesis, comparison, write scope, evidence, validation gates, and rollback conditions before implementation starts.

Once a manifest reaches `implementing`, agents must not edit it. If the contract is wrong or incomplete, the controller closes that run and creates a new manifest revision; an implementer cannot reinterpret or extend the existing contract.

## Immutable Manifest Schema

Every manifest is valid JSON and contains all of these fields:

- `schema_version`: manifest schema identifier, currently `1`.
- `experiment`: object with immutable `id`, `name`, `phase`, `task`, and `status`.
- `purpose`: bounded reason for running the experiment.
- `hypothesis`: falsifiable expected outcome.
- `comparison`: object with `class`, `baseline_variant`, `candidate_variant`, and `single_variable`.
- `source`: pinned reference name, version, commit, and relevant reference behavior.
- `baseline`: full local SHA, short SHA, branch, and recorded verification evidence.
- `dependencies`: experiment IDs that must already be adopted and documented.
- `target_artifact`: exact visual, correctness, or performance behavior the candidate is intended to improve or preserve.
- `known_regression_risks`: explicit quality, correctness, performance, platform, and maintenance risks evaluated by the experiment.
- `per_pass_and_compute_timing_budget`: numerical median/p95 limits for every affected pass and the total compute sum, including the declared noise-floor rule.
- `required_platform_divergence_evidence`: required platform reason, affected scenarios, visual impact, median/p95 impact, and maintenance cost.
- `scope`: exact repository-relative `allowed_write_paths` and explicit `forbidden_changes`.
- `commands`: required static and real-device commands, in execution order where order matters.
- `scenarios`: exact scenario IDs, ratios, dimensions, timestep, MSAA state, and required debug views.
- `capture_protocol`: exact absolute and event-relative frame captures, numerical image-equivalence rules, artifact rubric, and pass/fail aggregation.
- `validation_gates`: static, runtime, visual, timing, and review requirements.
- `timing_protocol`: feature requirements, warm-up, sample count, block order/repetitions, isolation, statistics, metadata, and invalidation rules.
- `expected_behavior`: output domain, presentation transform, jitter owner, velocity convention, reset behavior, resource graph, and binding expectations.
- `required_evidence`: complete evidence record required before a decision.
- `rollback_conditions`: conditions that immediately invalidate or revert the candidate.
- `result_contract`: allowed decision values and the evidence required to set one.
- `report_contract`: required agent status and handoff fields.

Arrays of file paths are literal allowlists, not examples or directory prefixes. A listed directory never authorizes unlisted descendants. Repository-relative paths are resolved from `/Users/dex/Developer/fsr3`.

Deterministic effect scenarios must define their renderer/device/pipeline/resource readiness barrier before recorded frame zero. Unrecorded readiness work may compile and allocate, but its temporal history must be cleared or source-defined reseeding must occur on recorded frame zero. A source-owned sampling sequence must cite the exact installed source/version and state its frame-index, rotation, offset, and noise formulas; a pinned private bridge requires a runtime shape guard and cannot be presented as public API.

Capture thresholds are immutable manifest inputs. Measured repeated-baseline behavior is evidence about the environment and may block a run, but it cannot widen max-absolute, RMSE, dimension, alpha, rubric, or aggregation limits.

## Result Decisions

The controller records exactly one decision after the evidence gates:

- `adopt`: candidate meets its quality, correctness, performance, and review gates.
- `iterate`: evidence supports another explicitly remanifested candidate; the current run is not adopted.
- `retain-local`: the local baseline remains preferable on measured quality, performance, or maintainability.
- `platform-divergence`: source parity is unavailable or materially worse because of a documented web/WebGPU constraint, and the measured local alternative is retained.
- `blocked`: the experiment cannot reach a valid decision because required capability, dependency, environment, or evidence is unavailable.

An implementation status such as `PASS` is not an adoption decision. Only the controller may set a result decision.

## Required Evidence Fields

Every result record must include:

- manifest ID, contract revision, immutable manifest digest, and working-tree digest;
- baseline and candidate IDs plus source and local SHAs;
- exact changed files and final diff summary;
- commands, exit codes, test counts, and timestamps;
- browser, browser version, operating system, adapter, backend, WebGPU features, three version, dimensions, DPR, ratio, settings, and shader/pipeline keys;
- validation logs covering WGSL compilation, WebGPU errors, uncaught exceptions, and device loss;
- scenario, frame, debug view, blinded A/B label, ROI, and artifact-rubric records for every capture;
- raw fresh GPU samples with frame tags, missing-sample count, per-pass and compute-sum median/p95, ABBA block results, and measured noise floor;
- reset, jitter-owner, active-resolver, output-domain, resource-graph, and binding checks;
- reviewer findings, fix-round count, unresolved concerns, decision, and decision rationale;
- platform reason and unsupported or degraded capability;
- affected scenario IDs, ratios, frames, debug views, and platforms;
- visual impact with blinded captures, ROIs, rubric grades, max-absolute error, and RMSE;
- per-pass and compute-sum median/p95 impact with raw samples and the measured noise floor;
- maintenance cost covering extra code paths, feature detection, tests, validation matrix, and likely upkeep for `platform-divergence`.

Evidence must describe failures and inconclusive measurements as recorded. Missing evidence cannot be inferred from screenshots, FPS, a successful build, or an agent assertion.

## Controller Responsibilities

The controller:

1. Authors and freezes the manifest before assigning implementation.
2. Confirms prerequisite decisions and the clean baseline.
3. Gives each agent the manifest and its exact file allowlist.
4. Rejects any unlisted write and classifies it as `SCOPE_BLOCKED`.
5. Serializes all implementation agents whose allowlists overlap by one or more exact paths.
6. Verifies changed paths and static commands before GPU work.
7. Runs or assigns real-device validation and evidence collection.
8. Assigns a fresh read-only task review.
9. Consolidates critical and important findings into no more than two fix rounds.
10. Makes the result decision and updates `bench/PARITY-PROGRESS.md`.
11. Starts dependent work only from an adopted, documented integration state.

The controller may narrow a task without changing its manifest. Any expansion requires a new manifest revision before work resumes.

Parallel work is permitted only when every participant is read-only, independent, and has no shared mutable artifact or integration state. Implementation agents with overlapping allowlists are never concurrent, even if they intend to edit different paths from those lists.

## Agent Responsibilities

Implementers:

- write only exact paths in `scope.allowed_write_paths`;
- make only the change described by the hypothesis and `single_variable`;
- stop with `SCOPE_BLOCKED` before touching any additional path;
- do not edit manifests, the progress ledger, unrelated algorithms, public APIs, dependencies, CI, or documentation unless each exact path is allowed;
- run required commands that are available in their assigned environment;
- return only the required report fields with complete artifacts, gate results, evidence, and concerns.

Reviewers and research agents remain read-only. Validation agents may create artifacts only when their exact artifact paths are listed in a separate manifest. No agent may expand scope, silently fix adjacent issues, commit, create a branch/worktree, or run baseline and candidate simultaneously during authoritative timing.

## Handoff Status

Every agent handoff uses exactly one of:

`PASS | FAIL | BLOCKED | SCOPE_BLOCKED | USER_DECISION_REQUIRED`

It also includes:

`changed_files | commands | artifacts | gates | concerns`

`PASS` means the assigned task and its available gates passed; it does not mean the candidate is adopted.
