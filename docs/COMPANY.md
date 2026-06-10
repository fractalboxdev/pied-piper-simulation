# Pied Piper Company Card

Canon reference for **Pied Piper, the company** (HBO *Silicon Valley*) — the machine-usable
counterpart to the [persona cards](../PERSONAS.md). Where PERSONAS.md tells the hydrator *how
people talk*, this file tells the generator and hydrator *what the company is at any point in
its history*: eras, products, business relationships, and org facts. It exists to serve
[CLAUDE.md](../CLAUDE.md)'s time-travel requirement — "Pied Piper at seed stage" vs. "after
the platform pivot" must resolve to concrete, structured facts.

**Source.** Primary: the fan-maintained
[Silicon Valley Fandom wiki](https://silicon-valley.fandom.com/wiki/Pied_Piper_(company))
(fetched via its MediaWiki API; pages: *Pied Piper (company)*, *Hooli*, *Weissman score*,
*Pied Piper (algorithm)*, *Intersite*, *The box*, *Nucleus*, *Raviga*, *TechCrunch Disrupt*),
supplemented from the show itself where the wiki is thin. The wiki is fan-written and
occasionally self-contradictory (e.g. it states both \$200K and \$300K for Peter Gregory's
seed check; the show canon is **\$200K for 5%**) — we cite it as reference, not gospel.
Season references (`S1`–`S6`) are the show's seasons; our `sim_time` axis is independent
(eras carry an *ordering*, not real dates).

**Format contract.** Mirrors PERSONAS.md: tooling parses **only** the fenced
` ```json era `, ` ```json product `, ` ```json relationship `, and ` ```json org ` blocks —
the surrounding prose is for humans. Do not duplicate the data into a separate JSON/YAML
file; edit it here.

Era fields:

| field | meaning |
|---|---|
| `slug` | stable era handle — referenced by fixtures (`FIXTURE_ERA_SLUG`) and future hyperparameter configs |
| `name` | human-readable era name |
| `order` | ordering index along `sim_time` (lower = earlier); eras are contiguous and non-overlapping |
| `season_ref` | show season(s) the era corresponds to |
| `products` | product slugs (see Products) active/being built in this era |
| `headcount` | rough company headcount during the era |
| `headline_metrics` | small bag of era-defining numbers (valuations, scores, user counts) |
| `notable_arcs` | canon arcs the generator can schedule inside this era |
| `simulated` | `false` only for the canon ending our timelines branch *before* (see Divergence) |

---

## Eras

The company's history as a structured timeline. The generator should treat era boundaries as
the coarse phase of every hyperparameter curve (headcount, burn, deal velocity, drama level);
the hydrator should treat the era at an event's `sim_time` as world-state context.

### 0 · Garage / incubator (Erlich's Hacienda)

Richard Hendricks, a Hooli employee, writes a lossless compression algorithm with a
record-shattering compression quality inside Erlich Bachman's incubator house. A bidding war
erupts: Gavin Belson (Hooli) offers \$10M outright; Peter Gregory (Raviga) offers \$200K for
5% — Richard takes the seed and builds a company instead. Jared Dunn quits Hooli to join.
Hooli starts Nucleus to reverse-engineer the algorithm. (S1)

```json era
{
  "slug": "incubator",
  "name": "Garage / incubator (Erlich's Hacienda)",
  "order": 0,
  "season_ref": "S1",
  "products": ["middle-out-algorithm"],
  "headcount": 5,
  "headline_metrics": { "seed_round_usd": 200000, "seed_equity_pct": 5, "declined_acquisition_usd": 10000000 },
  "notable_arcs": [
    "hooli-bidding-war",
    "peter-gregory-seed",
    "jared-defects-from-hooli",
    "nucleus-rivalry-begins",
    "cap-table-and-incorporation"
  ],
  "simulated": true
}
```

### 1 · TechCrunch Disrupt win

Cornered at TechCrunch Disrupt by Nucleus matching their score (2.89 — the believed
theoretical Weissman limit), Richard rewrites the engine overnight around **middle-out**
compression and demos a **Weissman score of 5.2**, the highest in history. Pied Piper wins
Disrupt and the \$50K prize; the company is suddenly the most famous startup in the Valley. (S1 finale)

```json era
{
  "slug": "disrupt",
  "name": "TechCrunch Disrupt win (middle-out breakthrough)",
  "order": 1,
  "season_ref": "S1",
  "products": ["middle-out-algorithm"],
  "headcount": 5,
  "headline_metrics": { "weissman_score": 5.2, "previous_theoretical_limit": 2.89, "prize_usd": 50000 },
  "notable_arcs": ["disrupt-finals", "middle-out-rewrite", "nucleus-beaten"],
  "simulated": true
}
```

### 2 · Raviga Series A & the Hooli lawsuit

Peter Gregory dies; Laurie Bream takes over Raviga and leads the Series A (Richard
deliberately takes a *lower* valuation to avoid a down-round trap). Hooli sues for IP theft,
freezing fundraising; Russ Hanneman bridges with toxic money. Pied Piper wins the **Intersite**
contract (~\$20M) in a live bake-off against Endframe, survives the livestream-condor-egg
ordeal, and finally beats the lawsuit in binding arbitration on Hooli's own unlawful
employment contracts. (S2)

```json era
{
  "slug": "series-a",
  "name": "Raviga Series A & Hooli lawsuit",
  "order": 2,
  "season_ref": "S2",
  "products": ["middle-out-algorithm", "compression-platform"],
  "headcount": 8,
  "headline_metrics": { "intersite_contract_usd": 20000000 },
  "notable_arcs": [
    "sand-hill-shuffle-series-a",
    "hooli-ip-lawsuit",
    "russ-hanneman-bridge",
    "intersite-bake-off-vs-endframe",
    "condor-cam-livestream",
    "binding-arbitration-win"
  ],
  "simulated": true
}
```

### 3 · Platform vs. the box (Maleant era)

Raviga installs "Action Jack" Barker as CEO. The team builds the consumer **compression
platform** (cloud storage + neural-net-improved compression); Barker instead sells a
hardware appliance — **the box** — to **Maleant Data Systems Solutions**. Board war ensues;
the platform beta dazzles engineers but flops with normal users ("Daily Active Users"
crisis), Jared secretly buys click-farm users, and the scandal craters the company's
reputation. Bachmanity (Erlich + Big Head) buys Pied Piper for \$1,000,001. (S3)

```json era
{
  "slug": "platform-box",
  "name": "Compression platform vs. the box (Maleant deal)",
  "order": 3,
  "season_ref": "S3",
  "products": ["compression-platform", "the-box"],
  "headcount": 12,
  "headline_metrics": { "platform_installs": 500000, "daily_active_users": 19000, "bachmanity_acquisition_usd": 1000001 },
  "notable_arcs": [
    "jack-barker-ceo",
    "maleant-box-deal",
    "platform-beta-launch",
    "daily-active-users-crisis",
    "click-farm-scandal",
    "bachmanity-acquisition"
  ],
  "simulated": true
}
```

### 4 · PiperChat (video chat pivot)

Dinesh's side hack — a video chat app built on the algorithm — organically takes off where
the platform failed. The company pivots: **PiperChat**, Dinesh briefly CEO. Growth is
explosive until a COPPA liability (underage users, ~\$21B in theoretical fines) surfaces;
Gavin Belson acquires PiperChat and eats the liability, getting himself fired from Hooli in
the process. (S4)

```json era
{
  "slug": "piperchat",
  "name": "PiperChat — video chat pivot",
  "order": 4,
  "season_ref": "S4",
  "products": ["piperchat"],
  "headcount": 10,
  "headline_metrics": { "dau_peak": 125000, "coppa_exposure_usd": 21000000000 },
  "notable_arcs": [
    "dinesh-ceo",
    "piperchat-viral-growth",
    "coppa-crisis",
    "hooli-acquires-piperchat"
  ],
  "simulated": true
}
```

### 5 · New Internet (decentralized pivot)

Richard's thesis: use middle-out to build a **peer-to-peer decentralized internet** on
users' phones — no data centers, no gatekeepers. The patent turns out to be Gavin's; they
trade for it. First commercial pilot: the **FGI** insurance data contract, nearly destroyed
by the smart-fridge data spill. The era ends with the Hooli-Con Wi-Fi jacking that seeds the
network with 123,000 devices. (S4)

```json era
{
  "slug": "new-internet",
  "name": "New Internet — decentralized pivot",
  "order": 5,
  "season_ref": "S4",
  "products": ["pipernet"],
  "headcount": 10,
  "headline_metrics": { "fgi_pilot_devices": 30000, "hoolicon_seeded_devices": 123000 },
  "notable_arcs": [
    "decentralized-internet-thesis",
    "gavin-patent-deal",
    "fgi-insurance-pilot",
    "smart-fridge-data-spill",
    "hoolicon-wifi-jacking"
  ],
  "simulated": true
}
```

### 6 · PiperNet platform & PiedPiperCoin

**PiperNet** runs for real: B2B customers (notably **K-Hole Games**) buy decentralized
compute/storage, the team acquihires from collapsed startups (Optimoji, SliceLine), survives
the Seppen smart-fridge lawsuit, and fends off a **51% attack** from YaoNet + Hooli. When
Laurie Bream's financing play turns hostile, the company funds itself with an ICO —
**PiedPiperCoin**. This is the "platform era" our fixture dataset is pinned to
(`FIXTURE_ERA_SLUG = "pipernet"` in `scripts/fixtures/data.ts`). (S5)

```json era
{
  "slug": "pipernet",
  "name": "PiperNet platform & PiedPiperCoin ICO",
  "order": 6,
  "season_ref": "S5",
  "products": ["pipernet", "piedpipercoin"],
  "headcount": 50,
  "headline_metrics": { "engineers_hired": 30, "attack_threshold_pct": 51 },
  "notable_arcs": [
    "pipernet-launch",
    "k-hole-games-customer",
    "optimoji-sliceline-acquihires",
    "seppen-lawsuit",
    "fifty-one-percent-attack",
    "piedpipercoin-ico"
  ],
  "simulated": true
}
```

### 7 · Hypergrowth (carrier deal, RussFest, buying Hooli)

PiperNet at scale: a major **AT&T** carrier partnership puts the network on real telecom
infrastructure, **RussFest** (Russ Hanneman's desert festival) runs entirely on PiperNet as
a showcase, the company raises toward a multi-billion valuation, moves into real offices,
grows toward ~500 employees — and Richard buys what's left of **Hooli** outright
("Hooli Smokes!"). (S6)

```json era
{
  "slug": "hypergrowth",
  "name": "Hypergrowth — AT&T deal, RussFest, acquiring Hooli",
  "order": 7,
  "season_ref": "S6",
  "products": ["pipernet", "piedpipercoin"],
  "headcount": 500,
  "headline_metrics": { "series_b_target_usd": 1000000000 },
  "notable_arcs": [
    "att-carrier-deal",
    "russfest-on-pipernet",
    "hooli-smokes-acquisition",
    "tethics-feud",
    "scale-org-growing-pains"
  ],
  "simulated": true
}
```

### 8 · Divergence point — the canon ending we do NOT simulate

In the show's finale, PiperNet's AI gets so good at optimization it threatens global
encryption; the team deliberately tanks the launch and shuts the company down (S6, "Exit
Event"). **Our simulation branches before this**: per CLAUDE.md §3, demo timelines fork from
the going-concern history (typically inside `pipernet` or `hypergrowth`) and continue the
company indefinitely. This block exists so the divergence is an explicit, structured fact —
not an omission.

```json era
{
  "slug": "exit-event",
  "name": "Shutdown (canon ending — not simulated)",
  "order": 8,
  "season_ref": "S6",
  "products": ["pipernet"],
  "headcount": 500,
  "headline_metrics": {},
  "notable_arcs": ["ai-breaks-encryption", "deliberate-failed-launch", "company-shutdown"],
  "simulated": false
}
```

---

## Products

The quality metric throughout is the **Weissman score** — the show's (fictional, but
formally specified) compression benchmark. The believed theoretical limit was **2.89**
(Hooli's Nucleus hit exactly that); Richard's middle-out breakthrough reached **5.2**.
Plausible in-world values therefore live in **2.0–5.2**: ~2.0–2.9 for conventional
codecs, ~2.9 for state-of-the-art rivals, >2.9 only for middle-out, 5.2 the canonical
ceiling. Fixture/generator metrics must stay in this range.

```json product
{
  "slug": "middle-out-algorithm",
  "name": "Pied Piper middle-out compression algorithm",
  "era_introduced": "incubator",
  "description": "Lossless universal compression; the core IP everything else is built on. Achieved the record 5.2 Weissman score at TechCrunch Disrupt.",
  "metric": { "name": "weissman_score", "plausible_range": [2.0, 5.2], "breakthrough": 5.2, "old_theoretical_limit": 2.89 }
}
```

```json product
{
  "slug": "compression-platform",
  "name": "Pied Piper compression platform",
  "era_introduced": "series-a",
  "description": "Cloud compression/storage platform with a neural net that improves as more files are uploaded. Beloved by engineers, impenetrable to everyone else (S3 DAU crisis).",
  "metric": { "name": "daily_active_users" }
}
```

```json product
{
  "slug": "the-box",
  "name": "The box (PiperBox appliance)",
  "era_introduced": "platform-box",
  "description": "On-prem hardware compression appliance built for the Maleant Data Systems deal under Jack Barker; later divested and reborn at Hooli as Box 2/3.",
  "metric": { "name": "units_shipped" }
}
```

```json product
{
  "slug": "piperchat",
  "name": "PiperChat",
  "era_introduced": "piperchat",
  "description": "Video chat with algorithm-grade quality on poor connections; Dinesh's side project gone viral. Acquired by Hooli after the COPPA crisis.",
  "metric": { "name": "daily_active_users" }
}
```

```json product
{
  "slug": "pipernet",
  "name": "PiperNet (the New Internet)",
  "era_introduced": "new-internet",
  "description": "Peer-to-peer decentralized internet built on middle-out: user devices contribute storage/compute as network nodes; B2B customers buy decentralized compute, storage, and transcode.",
  "metric": { "name": "network_nodes" }
}
```

```json product
{
  "slug": "piedpipercoin",
  "name": "PiedPiperCoin",
  "era_introduced": "pipernet",
  "description": "Utility token from the S5 ICO that financed the company when conventional VC turned hostile; later tied to network usage incentives.",
  "metric": { "name": "token_price_usd" }
}
```

---

## Business relationships

Canon investors, customers, partners, and rivals — the naming pool for fixtures and
generated deals. `kind` ∈ `investor | customer | partner | rival`. One-line context +
season ref each; fixture deal stages should reflect these arcs
(see `scripts/fixtures/data.ts`).

```json relationship
{ "slug": "raviga", "name": "Raviga Capital", "kind": "investor", "season_ref": "S1-S5", "context": "Peter Gregory's (later Laurie Bream's) VC firm; seed ($200K for 5%) and Series A lead; relationship turns hostile under Laurie in S5." }
```

```json relationship
{ "slug": "bream-hall", "name": "Bream-Hall", "kind": "investor", "season_ref": "S4-S5", "context": "Laurie Bream and Monica Hall's spin-out fund after leaving Raviga; backs Pied Piper until the S5 falling-out (Monica rejoins Pied Piper as CFO)." }
```

```json relationship
{ "slug": "coleman-blair", "name": "Coleman Blair Partners", "kind": "investor", "season_ref": "S2-S3", "context": "Sand Hill VC firm in the S2 funding carousel; famously pitched/spurned during the down-round dance and the S3 'Bad Money' shopping." }
```

```json relationship
{ "slug": "russ-hanneman", "name": "Russ Hanneman", "kind": "investor", "season_ref": "S2, S6", "context": "'Three comma club' billionaire; toxic bridge financing in S2; returns as the RussFest customer in S6." }
```

```json relationship
{ "slug": "maleant", "name": "Maleant Data Systems Solutions", "kind": "customer", "season_ref": "S3", "context": "Enterprise data company; bought the box (hardware appliance) under Jack Barker — the deal at the center of the S3 platform-vs-box board war." }
```

```json relationship
{ "slug": "intersite", "name": "Intersite", "kind": "customer", "season_ref": "S2", "context": "Adult-content giant; ~$20M storage/transcode contract won in a live bake-off against Endframe." }
```

```json relationship
{ "slug": "fgi", "name": "FGI", "kind": "customer", "season_ref": "S4", "context": "Insurance company; first commercial pilot of the decentralized internet (data stored across user devices), nearly lost in the smart-fridge spill." }
```

```json relationship
{ "slug": "k-hole-games", "name": "K-Hole Games", "kind": "customer", "season_ref": "S5", "context": "Game studio running on PiperNet — the marquee compute customer whose launch the 51% attack threatened." }
```

```json relationship
{ "slug": "russfest", "name": "RussFest", "kind": "customer", "season_ref": "S6", "context": "Russ Hanneman's desert festival, run entirely on PiperNet as the network's public stress test." }
```

```json relationship
{ "slug": "att", "name": "AT&T", "kind": "partner", "season_ref": "S6", "context": "Carrier partnership putting PiperNet on real telecom infrastructure — the deal that takes the network to scale." }
```

```json relationship
{ "slug": "hooli", "name": "Hooli", "kind": "rival", "season_ref": "S1-S6", "context": "Gavin Belson's conglomerate: failed $10M acquisition, Nucleus clone, IP lawsuit, Endframe purchase, PiperChat acquisition, 51% attack — and finally acquired BY Pied Piper in S6." }
```

```json relationship
{ "slug": "endframe", "name": "Endframe", "kind": "rival", "season_ref": "S2-S3", "context": "Middle-out copycat that stole the pitch; lost the Intersite bake-off; bought by Hooli for $250M." }
```

```json relationship
{ "slug": "yaonet", "name": "YaoNet", "kind": "rival", "season_ref": "S5", "context": "Yao's Chinese decentralized network built on Jian-Yang's knockoff; co-conspirator in the 51% attack on PiperNet." }
```

```json relationship
{ "slug": "seppen", "name": "Seppen", "kind": "customer", "season_ref": "S5", "context": "Smart-fridge manufacturer; sued Pied Piper over the hacked-fridge incident (a Hooli put-up job) before settling — an ambivalent account, not a happy one." }
```

```json relationship
{ "slug": "bachmanity", "name": "Bachmanity", "kind": "investor", "season_ref": "S3", "context": "Erlich Bachman + Nelson Bighetti's venture vehicle; bought Pied Piper for $1,000,001 after the click-farm scandal." }
```

---

## Org facts

Founding team mapped to [PERSONAS.md](../PERSONAS.md) slugs. Headcount per era lives in the
era blocks above (5 → ~10 → ~50 → ~500); the org chart over `sim_time` is our own data
(CLAUDE.md §6) and should interpolate between those marks.

```json org
{
  "founding_team": [
    { "persona": "richard", "role": "CEO & Founder", "joined_era": "incubator" },
    { "persona": "erlich", "role": "Board Member & Chief Evangelist (10% via incubator)", "joined_era": "incubator" },
    { "persona": "gilfoyle", "role": "Systems Architect (Infra & Security)", "joined_era": "incubator" },
    { "persona": "dinesh", "role": "Lead Engineer", "joined_era": "incubator" },
    { "persona": "jared", "role": "Chief Operating Officer (ex-Hooli)", "joined_era": "incubator" },
    { "persona": "monica", "role": "Board (Raviga) -> CFO", "joined_era": "incubator" },
    { "persona": "jianyang", "role": "App Developer (incubator resident)", "joined_era": "incubator" },
    { "persona": "bighead", "role": "Advisor (ex-Hooli, ex-Stanford)", "joined_era": "series-a" }
  ],
  "headcount_by_era": {
    "incubator": 5, "disrupt": 5, "series-a": 8, "platform-box": 12,
    "piperchat": 10, "new-internet": 10, "pipernet": 50, "hypergrowth": 500
  }
}
```
