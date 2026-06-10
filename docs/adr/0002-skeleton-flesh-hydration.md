# 2. Skeleton/flesh split: deterministic structured events + async LLM hydration

- Status: Accepted
- Date: 2026-06-10
- Deciders: FractalBox

## Context

[ADR-0001](0001-deterministic-generator-core-drop-paperclip.md) established the deterministic generator core and allowed LLMs in exactly one generation-adjacent role: *offline authoring of flavor content, cached keyed by event id*. It did not specify **how** that authoring composes with fast-forward, time travel, and playback without ever blocking or breaking them. Open questions:

1. **Where exactly does the LLM sit** so that generating years of events stays a pure, seconds-fast computation?
2. **How does playback behave** when LLM content for a window hasn't been authored yet?
3. **How do we get *coherent* prose** (a Slack argument where message 3 knows what message 2 said) when per-event LLM calls are stateless?
4. **What precisely is deterministic** — the event stream, the prose, or both?

The latent failure mode is *prose becoming load-bearing*: as soon as any downstream event depends on LLM-generated text, the model is back in the generation loop and ADR-0001's guarantees silently collapse.

## Decision

**Every event is split across two planes. The simulation engine produces only the deterministic *skeleton*; an asynchronous *hydrator* produces the LLM-authored *flesh*, written to a cache that playback reads with a template fallback.**

### Skeleton plane (deterministic, fast)

The discrete-event engine emits fully **structured** events — actor, type, channel/target, intent, sentiment, magnitude, references — e.g. `SlackMessagePosted { author: "gilfoyle", channel: "#infra", arcId: "incident-42", intent: "deflect-blame", sentiment: "snarky" }`. Everything any projection, sink, or downstream event needs lives in structured fields. Generation remains `seed + hyperparameters → events`, pure and LLM-free; fast-forwarding years takes seconds.

**Invariant (the load-bearing rule): no event may depend on the *prose* of another event — only on structured fields.** If a future event must "react to what Gilfoyle said", the reaction-relevant bit is encoded as a skeleton field (`intent`, `outcome`, `decision`) and the hydrator must honor it when writing prose — never the other way around.

### Flesh plane (LLM, async, cached)

A **hydrator** worker walks the event log and renders skeleton events into realistic surface prose (Slack message bodies, Linear descriptions, retro docs). Output goes to a content cache keyed by `(timeline_id, event_id, prompt_hash)`.

- **Arcs, not events, are the unit of hydration.** The engine groups related events into **narrative arcs** (`arc_id` on events): incident → Slack thread → Linear issue → postmortem is one arc with participants, beats, and outcome — all deterministic skeleton data. The hydrator renders one arc (or one thread) per LLM call, so internal coherence is free.
- **Prompts are pure functions of the log.** Prompt inputs are: versioned **persona cards** (character bibles for Richard, Gilfoyle, Jared, … kept in-repo), the arc's structured beats, and a bounded **world-state digest** (the projection at the arc's start `sim_time`, top-k facts — not the whole log). Pure inputs ⇒ `prompt_hash` is a stable cache key and improving prompts auto-invalidates exactly the affected entries.
- **Cursor-priority hydration.** The hydrator prioritizes the window around the playback cursor — hydrate what the audience is about to see. Jumping the cursor (time travel or fast-forward) re-prioritizes the queue; it never blocks the jump.

### Playback fallback

On read, projection resolves content as: cache hit → LLM prose; miss → **deterministic template rendering of the same structured fields**. The template author and the LLM author implement the **same port** (`LLMAuthor` / `TemplateAuthor`), so the no-LLM baseline of ADR-0001 *is* the fallback path — one code path, graceful degradation from "great prose" to "fine prose", and demos never block.

### Two determinism tiers

- **Structural determinism (default):** the event stream is bit-identical across runs; prose may differ if regenerated cold. Sufficient for almost everything because prose is never load-bearing.
- **Full determinism (canned demos):** the populated content cache is part of the demo artifact — snapshot it with the timeline; replay reads cache only, never the model.

### Schema sketch

```
events(timeline_id, event_id, sim_time, wall_time, type, payload jsonb, arc_id, seq)
arcs(arc_id, timeline_id, kind, start_sim_time, end_sim_time, participants jsonb, beats jsonb)
content_cache(cache_key pk, timeline_id, event_id, prompt_hash, model, body, tokens, wall_time)
hydration_queue(arc_id, priority, status)   -- priority = distance from playback cursor
```

Forked timelines share the parent's cache for the common event prefix (prefix events are identical and the key includes `event_id`), so branches are nearly free to hydrate.

### Cost & model tiering

Hydration is async by design, so the Anthropic **Batch API** (50% cheaper) is the default adapter. Model tier is a hyperparameter: small models for routine chatter, large models for arcs that matter (board meetings, incidents, retros). A `tokens_per_sim_month` budget knob keeps "long-running & cheap" honest. Hydrate once, replay forever.

## Consequences

**Positive**

- Fast-forward, time travel, and determinism are structurally immune to the LLM: the model is unreachable from the generation and projection code paths (enforced by the Layer graph — the read path has no LLM client dependency at all).
- Coherent, in-character prose via arc-level hydration + persona cards, at batch-API prices.
- The template baseline and the LLM path are one port — shipping the baseline first (per ADR-0001) builds the fallback for free.
- Re-hydration with better models/prompts later changes prose only; every existing timeline, projection, and demo remains valid.

**Negative / costs**

- Two planes to keep coherent: skeleton fields must carry enough semantics for both projections and prompts; impoverished skeletons produce generic prose.
- The "prose is never load-bearing" invariant needs active enforcement in review — it is the single rule whose violation collapses the design.
- World-state digests must stay bounded or prompt size (and cost) grows with sim age.
- The hydrator is a second long-running worker to operate (queue, retries, rate limits) — though failure only degrades prose quality, never correctness.

## Alternatives considered

- **Synchronous LLM calls during generation.** Rejected: puts model latency and availability on the fast-forward path; years-in-seconds becomes hours and a provider outage halts generation.
- **Per-event hydration (no arcs).** Rejected: stateless per-message calls produce incoherent threads; arc-level calls are also cheaper (fewer, larger calls).
- **LLM-generated events (model decides what happens).** Rejected: this is ADR-0001's rejected agent model by another name — nondeterministic, unreproducible, conflicts with virtual time.
- **Prose-level determinism everywhere (pin every output forever).** Rejected as default: makes prompt/model improvements invasive. Offered as the opt-in "full determinism" tier for canned demos instead.
