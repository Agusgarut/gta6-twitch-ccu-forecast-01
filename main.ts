// Forecast for the GTA VI launch-day Twitch viewer count, hour by hour.
//
// What this program does, in one paragraph: it reads the single case file
// the grader gives it (hour 1 of release day already known, plus the
// release-day curves of 38 past big launches that come inside the case),
// and for each of hours 2..24 it answers five quantiles of that hour's
// viewer count. Everything is computed from the case file at run time:
// nothing is fetched, no table is shipped, and the same input always
// produces the same bytes.
//
// The forecast itself is built on log-ratios, because viewer counts
// differ by orders of magnitude between launches while the *shape* of a
// launch day is similar. For a past launch, look at
// log(viewers in hour h / viewers in hour 1). Across past launches that
// ratio has a clear daily shape: it dips a little in the small hours,
// then climbs steeply into the evening as the US wakes up and Europe
// hits prime time, peaking around hours 19-21 at roughly twice hour 1.
//
// Two things make the naive version of that idea fail, and both are
// handled here:
//
// 1. Hour 1 means different things for different launches. A game that
//    unlocked at midnight local time everywhere already has most regions
//    playing in hour 1, so its later ratios stay near 1-3x. A game with
//    one simultaneous global unlock later in the day has almost nobody
//    in hour 1 and ratios of 50-200x by evening. Mixing those two kinds
//    wrecks the median. So past launches are split by their hour-1 size
//    (20,000 viewers): the target is only ever compared with launches
//    whose hour 1 looked like its own. GTA VI unlocks at rolling
//    midnight local time, New Zealand first, so by hour 1 New Zealand,
//    Australia, Asia, Europe and the UK are already playing and hour 1
//    will be large — the big-hour-1 group is the right peer set.
//
// 2. Launches whose hour 1 was already close to their pre-release peak
//    grow less than launches that were still ramping. The program
//    measures that with the target's own history: the median hourly
//    viewer count in the 24 hours before release day. A small
//    straight-line fit of log-ratio against log(hour-1 / pre-release
//    median), shrunk towards zero so a handful of points cannot drag
//    the forecast around, is blended 70/30 with the plain
//    peer median; with too few points, keep the median.
//
// The spread is the honest one: the spread of the peer log-ratios at
// that hour, never narrower than the house baseline's widening spread,
// so the 5%..95% band covers about nine hours in ten. Past launches
// whose release was distorted by early access are still useful as
// peers (their day shape is flatter, which steadies the median), but
// free-to-play and slow-burn launches and the target game's own
// pre-release history are left out: they are not the same kind of day.
//
// Output: one <id>.out per <id>.in, exactly { "hours": [
// { "hour": 2, "q": [q05, q25, q50, q75, q95] }, ... ] } for hours
// 2..24, quantiles non-decreasing, positive, rounded to 2 decimals.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

// The five levels the contest scores, in the order each row lists them.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Standard-normal quantiles at those levels.
const NORMAL_Z = [-1.645, -0.674, 0, 0.674, 1.645];
// Hour-1 size that separates "already playing at midnight" launches
// from "unlock still to come" launches.
const BIG_LAUNCH = 20000;
// How much of the history-adjusted median to trust versus the plain
// peer median. 0.7: the adjustment earned its weight in leave-one-out
// testing on the kit's own launches (it beat the plain median on both
// the big-hour-1 and the small-hour-1 groups), but it is not trusted
// outright, because the target's pre-release history is measured
// differently from the comparables' in the final case.
const HISTORY_BLEND = 0.7;
// The house baseline's per-root-hour log spread; the forecast spread
// is never allowed below this widening floor.
const BASE_SPREAD = 0.15;

type HourlyPoint = { from?: string; at?: string; viewers?: number; channels?: number };
type Comparable = {
  name?: string;
  day_start?: string;
  unlock?: string;
  hourly?: HourlyPoint[];
};
type CaseFile = {
  levels?: number[];
  known?: Array<{ hour?: number; viewers?: number }>;
  forecast?: Array<{ hour?: number }>;
  day_start?: string;
  checkpoint?: string;
  history?: HourlyPoint[];
  history_hourly?: HourlyPoint[];
  comparables?: Comparable[];
};

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function spreadOf(values: number[]): number {
  if (values.length < 2) return 0.5;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

// Straight line y = a + b*x through the given points, with the slope
// pulled towards zero when there are few points.
function fittedLine(xs: number[], ys: number[]): { intercept: number; slope: number } {
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) * (xs[i] - meanX);
  }
  const rawSlope = sxx === 0 ? 0 : sxy / sxx;
  const slope = rawSlope * (n / (n + 5));
  return { intercept: meanY - slope * meanX, slope };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// The house persistence forecast for one hour, used only when a case
// carries no usable peers for that hour.
function persistenceRow(firstPrint: number, hour: number): number[] {
  const widen = BASE_SPREAD * Math.sqrt(hour - 1);
  return NORMAL_Z.map((z) => Math.max(0.01, round2(firstPrint * Math.exp(z * widen))));
}

function hourOf(millis: number, dayStartMillis: number): number {
  return Math.floor((millis - dayStartMillis) / 3600000) + 1;
}

// Mean viewers per release-day hour (1..24) from a launch's hourly
// series, plus the median hourly viewers in the 24 hours before the
// release day. Hours with no points are left out.
function releaseDayShape(
  hourly: HourlyPoint[] | undefined,
  dayStartText: string | undefined,
): { byHour: Map<number, number>; preDayMedian: number } {
  const byHour = new Map<number, number>();
  let preDayMedian = 0;
  if (!hourly || hourly.length === 0 || !dayStartText) return { byHour, preDayMedian };
  const dayStart = Date.parse(dayStartText);
  if (Number.isNaN(dayStart)) return { byHour, preDayMedian };
  const buckets = new Map<number, number[]>();
  const before: number[] = [];
  for (const point of hourly) {
    const stampText = point.from ?? point.at;
    if (!stampText) continue;
    const stamp = Date.parse(stampText);
    if (Number.isNaN(stamp)) continue;
    const viewers = Math.max(0, point.viewers ?? 0);
    const offsetHours = (stamp - dayStart) / 3600000;
    if (offsetHours >= -24 && offsetHours < 0) before.push(viewers);
    const hour = hourOf(stamp, dayStart);
    if (hour >= 1 && hour <= 24) {
      const bucket = buckets.get(hour) ?? [];
      bucket.push(viewers);
      buckets.set(hour, bucket);
    }
  }
  for (const [hour, values] of buckets) {
    byHour.set(hour, values.reduce((s, v) => s + v, 0) / values.length);
  }
  if (before.length > 0) preDayMedian = medianOf(before);
  return { byHour, preDayMedian };
}

function peerKind(entry: Comparable): "peer" | "skip" {
  const note = entry.unlock ?? "";
  const name = entry.name ?? "";
  if (note.includes("target-history") || name.includes("Grand Theft Auto VI")) return "skip";
  if (note.includes("weak")) return "skip";
  return "peer";
}

type Peer = { first: number; byHour: Map<number, number>; preDayMedian: number };

function collectPeers(cases: Comparable[] | undefined, wantBig: boolean): Peer[] {
  const peers: Peer[] = [];
  for (const entry of cases ?? []) {
    if (peerKind(entry) !== "peer") continue;
    const shape = releaseDayShape(entry.hourly, entry.day_start);
    const first = shape.byHour.get(1) ?? 0;
    if (!Number.isFinite(first) || first < 10) continue;
    const isBig = first >= BIG_LAUNCH;
    if (isBig !== wantBig) continue;
    peers.push({ first, byHour: shape.byHour, preDayMedian: shape.preDayMedian });
  }
  return peers;
}

function forecastCase(kase: CaseFile): { hours: Array<{ hour: number; q: number[] }> } {
  const levels = kase.levels ?? [];
  if (levels.length !== LEVELS.length || levels.some((level, i) => level !== LEVELS[i])) {
    throw new Error(`case asks for levels ${JSON.stringify(levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const firstRow = (kase.known ?? []).find((row) => row.hour === 1);
  if (!firstRow || !Number.isFinite(firstRow.viewers)) {
    throw new Error("case has no hour-1 print");
  }
  const firstPrint = Math.max(1, firstRow.viewers as number);
  const wantBig = firstPrint >= BIG_LAUNCH;

  // The target's own pre-release level, from its hourly history.
  const history = kase.history_hourly && kase.history_hourly.length > 0 ? kase.history_hourly : kase.history;
  const dayStartText = kase.day_start ?? kase.checkpoint;
  let targetPreDay = 0;
  if (history && dayStartText) {
    const dayStart = Date.parse(dayStartText);
    if (!Number.isNaN(dayStart)) {
      const before: number[] = [];
      for (const point of history) {
        const stampText = point.from ?? point.at;
        if (!stampText) continue;
        const stamp = Date.parse(stampText);
        if (Number.isNaN(stamp)) continue;
        if (stamp >= dayStart - 24 * 3600000 && stamp < dayStart) {
          before.push(Math.max(0, point.viewers ?? 0));
        }
      }
      if (before.length > 0) targetPreDay = medianOf(before);
    }
  }

  const peers = collectPeers(kase.comparables, wantBig);
  const wantedHours = (kase.forecast ?? []).map((row) => row.hour ?? 0).filter((h) => h >= 2 && h <= 24);

  const hours = wantedHours.map((hour) => {
    const ratios: number[] = [];
    for (const peer of peers) {
      const value = peer.byHour.get(hour);
      if (value !== undefined && value > 0) ratios.push(Math.log(value / peer.first));
    }
    if (ratios.length === 0) return { hour, q: persistenceRow(firstPrint, hour) };

    let centre = medianOf(ratios);
    const spread = Math.max(spreadOf(ratios), BASE_SPREAD * Math.sqrt(hour - 1));

    // History adjustment: launches whose hour 1 already towered over
    // their pre-release level grew less later in the day. Blend a
    // shrunk straight-line fit of that relationship 70/30 with the
    // peer median; with too few points, keep the median.
    if (targetPreDay > 0) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const peer of peers) {
        const value = peer.byHour.get(hour);
        if (value === undefined || value <= 0 || peer.preDayMedian <= 0) continue;
        xs.push(Math.log(peer.first / peer.preDayMedian));
        ys.push(Math.log(value / peer.first));
      }
      if (xs.length >= 5) {
        const fit = fittedLine(xs, ys);
        const adjusted = fit.intercept + fit.slope * Math.log(firstPrint / targetPreDay);
        centre = (1 - HISTORY_BLEND) * centre + HISTORY_BLEND * adjusted;
      }
    }

    const quantiles = NORMAL_Z.map((z) => Math.max(0.01, round2(firstPrint * Math.exp(centre + z * spread))));
    for (let i = 1; i < quantiles.length; i++) {
      if (quantiles[i] < quantiles[i - 1]) quantiles[i] = quantiles[i - 1];
    }
    return { hour, q: quantiles };
  });

  return { hours };
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const files = readdirSync(INPUT_DIR)
    .filter((name) => name.endsWith(".in"))
    .sort();
  for (const file of files) {
    const id = file.slice(0, -".in".length);
    const kase = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8")) as CaseFile;
    const forecast = forecastCase(kase);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(forecast)}\n`, "utf8");
  }
}

main();
