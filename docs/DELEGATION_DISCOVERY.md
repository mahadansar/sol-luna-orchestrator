# Delegation Discovery

Two different things have looked like "the model did not delegate", and
collapsing them loses real evidence. This document keeps them apart: benchmark
runs where the orchestrator was in front of the model and it chose solo, and
fresh real sessions where the orchestrator never entered consideration at all.

Only the second is a discovery problem.

## Benchmark zero-worker results were routing decisions, not discovery failures

In the benchmark suites the orchestrator was never something the model had to
find. Every arm's prompt named the tools explicitly — the free-choice arm opens
with "You have delegation tools available (delegate_task and delegate_tasks)" —
and the mandated arms exercised those tools on the same fixtures: 17 runs across
the parallel and scale suites actually delegated, with zero worker failures and
zero agent errors, which proves the tools were exposed, reachable and callable in
exactly that configuration. (Mandating delegation did not always produce it — on
the coupled control one repetition emitted no delegation events despite being told
it must. That is a recorded model behaviour, not a reachability finding.) Solo arms ran
with the server `enabled = false` rather than merely being told to abstain, so
the comparison was against a genuine absence of the capability.

Given that, the free-choice arm's zero-worker outcomes are routing decisions
taken with the orchestrator available: 0 of 6 free-choice scale runs delegated,
at one, four and six streams alike. Every one of those runs passed, and on two of
the three fixtures free choice was the fastest arm measured. No run produced
evidence that declining to delegate was the wrong call.

**Do not reinterpret those results as MCP discovery failures.** They are valid
historical evidence of adaptive routing under conditions where discovery was not
in question, and they are preserved as such in
[`bench/RESULTS.md`](../bench/RESULTS.md).

Two limits on how far they can be read, both stated in the raw results and worth
repeating here:

- **The runs do not record why.** The harness measured the decision, not the
  reasoning behind it. Any explanation of the model's motive — fixture size,
  scope, coupling — is inference, not measurement.
- **The fixtures were not uniformly small.** The scale suite ran four- and
  six-stream fixtures. "It declined because the work was trivial" is not a
  conclusion these runs support.

## The real problem: passive discovery in fresh sessions

Fresh Codex sessions failed differently. When the user did not mention this MCP
or delegation at all, the orchestrator could fail to enter consideration in the
first place. That is not the model evaluating delegation and rejecting it — it is
the model never getting as far as the guidance that would inform the decision.

The cause was the persistent discovery hint being too passive. `init` writes a
tiny exact block into the user-owned Codex instructions
(`AGENTS.md`, or `AGENTS.override.md` when that is the file Codex loads), between
`BEGIN`/`END` markers. The earlier text read:

> When delegated work may be useful, consider the configured
> sol-luna-orchestrator MCP before Codex built-in delegation. Delegation is
> optional; zero workers is valid.

"Consider" was doing no work. A parent that never looked at the server never saw
the tool descriptions, so there was nothing to consider.

## Current discovery behaviour

The managed hint now directs the parent to look first:

> For non-trivial work where delegation could plausibly help, first discover the
> configured sol-luna-orchestrator MCP and use its guidance to decide between
> solo work, delegate_task, or delegate_tasks. Do not substitute Codex built-in
> delegation. Zero workers is valid.

Three changes, each deliberate. Discovery comes **before** the decision, so the
decision is made against the real tool guidance. Substituting Codex's own
built-in delegation is ruled out, because a parent that delegates through another
mechanism gets none of this project's scoping, verification or isolation. And
zero workers is still explicitly valid, so the stronger hint does not turn into
pressure to delegate.

Live acceptance runs after this change have shown fresh sessions discovering the
orchestrator and consulting its guidance without the user naming the MCP or
delegation — see [Live Acceptance](ACCEPTANCE.md) for the procedure and how each
run is recorded. That is manual, model-backed evidence from a small number of
runs on one platform, not a deterministic guarantee: a hint is guidance to a
model, and no MCP server can compel a parent to read it.

The hint is also optional and yours to control. `init --no-discovery-hint` skips
it, `sol-luna-orchestrator status` reports whether it is installed, missing or
modified, and a block you have edited is treated as your content and left alone —
in which case the improvement above simply is not in effect.

## Adaptive routing is still the point

Better discovery makes the routing decision informed. It does not make delegation
mandatory, and nothing here should be read as a target for how often to delegate.
**Zero workers remains a valid, and often correct, outcome.** The orchestrator's
job is to be found, to explain its own trade-offs honestly, and then to let the
parent choose solo work when solo work is right.
