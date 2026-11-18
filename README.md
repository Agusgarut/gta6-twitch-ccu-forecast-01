[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Agusgarut/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Agusgarut/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

# GTA VI launch-day Twitch forecast

Forecasts how many people will be watching Grand Theft Auto VI live on
Twitch in each hour of its release day (19 November 2026, UTC), given
only the first hour's viewer count. For hours 2–24 it writes five
quantiles (5%, 25%, 50%, 75%, 95%) per hour, scored by pinball loss on
the log scale.

Entry for the [make.fun bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01):
forecast GTA VI's launch-day Twitch viewers hour by hour. One program,
`main.ts` (Node 22, standard library only, offline, deterministic).

## How it works

Everything is computed at run time from the single case file the
grader hands the program — no network, no shipped tables.

- **Log-ratios, not levels.** Viewer counts differ by orders of
  magnitude between launches, but the *shape* of a launch day is
  similar. For each past launch the program looks at
  `log(viewers in hour h / viewers in hour 1)` and takes the peer
  median per hour, with the peer spread as the forecast spread
  (floored at the house baseline's widening spread, so the band
  stays honest).
- **Peers are matched by hour-1 size.** A game that unlocked at
  midnight local time everywhere already has most regions playing in
  hour 1, so its later ratios stay near 1–3x. A game with one
  simultaneous global unlock later in the day has almost nobody in
  hour 1 and ratios of 50–200x by evening. Mixing the two wrecks
  the median, so launches are split at 20,000 hour-1 viewers and the
  target is only compared with launches whose hour 1 looked like its
  own. GTA VI unlocks at rolling midnight local time, so by hour 1
  New Zealand, Australia, Asia, Europe and the UK are already
  playing: it belongs in the big-hour-1 group.
- **A history adjustment.** Launches whose hour 1 already towered
  over their pre-release level grew less later in the day. The
  program measures that from the target's own history (median hourly
  viewers in the 24 hours before release day) and blends a shrunk
  straight-line fit of that relationship 70/30 with the peer median.
- **Peer set.** Past launches the kit itself tiers as comparable or
  early-access-contaminated. Free-to-play / slow-burn launches and
  the target game's own pre-release history are left out. With no
  usable peers for an hour, that hour falls back to the house
  persistence baseline.

## Local validation

There is no local grade for this bounty: the server grades the four
practice cases (p00–p03) after submission, and their answers are not
in the kit. So the model was validated by leave-one-out on the 38
past launches inside the kit itself — each launch treated as a
pseudo-case (its own hour 1 known, the other 37 launches as peers),
scored with the contest's pinball loss on the log scale:

| set | model | house baseline (persistence) |
| --- | --- | --- |
| all 26 clean launches | **0.496** | 1.084 |
| big hour-1 launches (the GTA VI regime, n=17) | **0.295** | 0.347 |
| small hour-1 launches (n=9) | **0.875** | 2.477 |

The model beats the baseline on 23 of 26 launches. Mean 90%
coverage is 0.87 (an honest forecast covers about 0.90). The
program is deterministic (byte-identical across runs) and fast
(~0.4 s for 26 cases; the limit is 8 s per case).

Caveat, as the rules themselves say: practice scores are no guide
to the final. The final is a single launch, GTA VI, whose hype is
beyond anything in the peer set — the forecast anchors on its
hour-1 print, so the level follows whatever hour 1 turns out to be.

## Run it locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/<id>.out` for every `<id>.in` in the input
directory: `{ "hours": [{ "hour": 2, "q": [q05, q25, q50, q75, q95] }, …] }`
for hours 2–24.
