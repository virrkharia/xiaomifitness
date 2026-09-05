// netlify/functions/manual-entry.mjs
//
// Accepts a single manually-entered reading for either the fitness or
// glucose store, and merges it in without disturbing anything else
// already recorded for that day. Fitness fields live either directly
// on the day object or nested under day.raw.<group>.<field> (matching
// pull-data.mjs's shape); glucose fields are flat on the daily
// aggregate entry.
//
// POST body (JSON): { source: "fitness"|"glucose", date: "YYYY-MM-DD",
//                      metric: "<key>", value: <number> }

import { getStore } from "@netlify/blobs";

const FITNESS_FIELD_MAP = {
  steps: { kind: "top", field: "steps" },
  distance_m: { kind: "top", field: "distance_m" },
  calories: { kind: "top", field: "calories" },
  sleep_total_min: { kind: "top", field: "sleep_total_min" },
  hr_avg: { kind: "raw", group: "heart_rate", field: "avg_hr" },
  intensity: { kind: "raw", group: "intensity", field: "duration" },
  standing: { kind: "raw", group: "valid_stand", field: "count" },
};

const GLUCOSE_FIELDS = new Set(["avg_mmol", "min_mmol", "max_mmol", "pct_in_range"]);

function blankFitnessDay(date) {
  return {
    date,
    steps: 0,
    distance_m: 0,
    calories: 0,
    sleep_total_min: 0,
    sleep_deep_min: 0,
    sleep_light_min: 0,
    sleep_start: null,
    sleep_end: null,
    raw: {},
  };
}

function blankGlucoseDay(date) {
  return {
    date,
    avg_mmol: null,
    min_mmol: null,
    max_mmol: null,
    reading_count: 0,
    pct_in_range: null,
    pct_below_range: null,
    pct_above_range: null,
  };
}

export default async (req) => {
  const jsonError = (message, status) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (req.method !== "POST") return jsonError("Use POST", 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError("Body must be JSON", 400);
  }

  const { source, date, metric, value } = body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonError("date must be YYYY-MM-DD", 400);
  const numValue = Number(value);
  if (!Number.isFinite(numValue)) return jsonError("value must be a number", 400);

  if (source === "fitness") {
    const mapping = FITNESS_FIELD_MAP[metric];
    if (!mapping) return jsonError(`Unknown fitness metric: ${metric}`, 400);

    const store = getStore("mifit-data");
    const daysArr = (await store.get("days", { type: "json" })) || [];
    const byDate = Object.fromEntries(daysArr.map((d) => [d.date, d]));

    const day = byDate[date] || blankFitnessDay(date);
    if (!day.raw) day.raw = {};

    if (mapping.kind === "top") {
      day[mapping.field] = numValue;
    } else {
      if (!day.raw[mapping.group]) day.raw[mapping.group] = {};
      day.raw[mapping.group][mapping.field] = numValue;
    }

    byDate[date] = day;
    const merged = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    await store.setJSON("days", merged);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (source === "glucose") {
    if (!GLUCOSE_FIELDS.has(metric)) return jsonError(`Unknown glucose metric: ${metric}`, 400);

    const store = getStore("glucose-data");
    const dailyArr = (await store.get("daily", { type: "json" })) || [];
    const byDate = Object.fromEntries(dailyArr.map((d) => [d.date, d]));

    const day = byDate[date] || blankGlucoseDay(date);
    day[metric] = numValue;

    byDate[date] = day;
    const merged = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    await store.setJSON("daily", merged);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return jsonError("source must be 'fitness' or 'glucose'", 400);
};

export const config = {
  path: "/api/manual-entry",
};
