# 1. Deterministic event generator as the core; drop Paperclip from the critical path

- Status: Accepted
- Date: 2026-06-10
- Deciders: FractalBox

## Context

The Pied Piper simulation must satisfy three hard requirements:

1. **Virtual time / speed-up** — compress months into hours (e.g. watch many "monthly retrospective" meetings in an afternoon).
2. **Time travel** — reconstruct and showcase the company *as it was* at any past point in time.
3. **Long-running & low-cost** — emit a stream of realistic-but-**mocked** Slack / Linear / Stripe data indefinitely, cheaply, to demo our products against a living dataset.

The original concept used [Paperclip](https://paperclip.ing/) to model the org chart and "run the company" with real LLM agents driven on wall-clock heartbeats.

Paperclip's real-agent model conflicts with all three requirements:

| Requirement | Deterministic generator | Paperclip (real agents) |
|---|---|---|
| Determinism (seed + hyperparams → reproducible) | ✅ pure functions | ❌ LLM outputs vary run-to-run |
| Speed-up (months in hours) | ✅ generate years in seconds | ❌ agents can't think 720× faster |
| Cost (indefinite runtime) | ✅ ~free | ❌ per-event tokens → unbounded |
| Time travel (project to any `sim_time`) | ✅ fold events | ❌ can't faithfully replay agent cognition |
| Operations | ✅ one system | ❌ second self-hosted app + its Postgres |

The decisive observation: **the data is explicitly mocked.** Producing realistic operational data does not require agents to actually perform work — it requires a *generative model of company behavior*. Real-time agents are a heavier, nondeterministic path to the same artifact, and they are the single component incompatible with virtual time.

## Decision

**The simulation core is a deterministic event generator. Paperclip (and real-time agents generally) are removed from the critical path.**

- The **org chart, roles, and reporting structure are modeled as our own data** in NeonDB, not delegated to an external system.
- The generator produces an append-only event log stamped with virtual `sim_time`; `seed + hyperparameters` is the reproducibility contract.
- Real agents are **optional and additive**, never a dependency:
  - **Live mode** — at the present edge only, at real pace, real agents (Paperclip *or* direct LLM calls) may react to the simulated world for demos where "agentic company" is the point.
  - **Offline authoring** — LLMs may author flavor content (Slack threads, retro notes) *during generation*, with output **cached keyed by event id** so determinism and replay still hold. The hot path reads the cache, never the model.

LLMs therefore play at most one of three roles, and only the cached/offline one may touch the generation path:
1. Live real-time actors → optional live-mode layer only.
2. Offline content authors → allowed if cached for determinism.
3. None (rules / templates / statistical models) → the baseline; ship this first.

## Consequences

**Positive**

- Determinism, speed-up, cheap long-running operation, and trivial time travel are all preserved — they fall out of a pure generator + event-sourced log.
- One system to operate instead of two; the wall-clock-heartbeat vs. virtual-time conflict disappears entirely.
- The "AI agents running a company" narrative is still available as an opt-in live mode for demos that want it.

**Negative / costs**

- We forgo Paperclip's ready-made org-chart / budget / audit UI and must model the org schema ourselves (modest — we owned that schema regardless).
- "Live mode" and "generated mode" are two code paths to keep coherent; live mode must attach only at the present edge to avoid reintroducing the virtual-time conflict.
- If offline LLM authoring is used, we must enforce the caching discipline or determinism silently breaks.

## Alternatives considered

- **Keep Paperclip as the core engine.** Rejected: incompatible with virtual time, determinism, and cost (see table).
- **Paperclip with a virtualized/accelerated clock.** Rejected: real LLM latency and nondeterminism cannot be compressed or made reproducible; replaying agent cognition for time travel is infeasible.
- **No LLMs at all, ever.** Viable baseline and the recommended starting point, but unnecessarily forecloses opt-in live-agent demos and cached LLM-authored flavor — both compatible with the core when kept off the deterministic hot path.
