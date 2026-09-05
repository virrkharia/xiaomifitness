// netlify/functions/targets.mjs
//
// Stores weekly targets (steps floor/target, sleep duration target,
// sleep window) and the week-start-day setting, in their own Blobs
// store. A target set for a given week carries forward automatically
// to any later week that hasn't had its own targets set -- "carry
// forward" is resolved at read time by the frontend (this endpoint
// just returns every explicitly-set week; the frontend finds the
// most recent one <= whatever week it's asking about).
//
// GET  /api/targets -> { weekStartDay, weekly: [...] }
// POST /api/targets with body:
//   { type: "config", weekStartDay: 0|1 }
//   { type: "weekly", week_start: "YYYY-MM-DD", steps_floor, steps_target,
//     sleep_target_min, sleep_window_start, sleep_window_end }
//   (any subset of the weekly fields is fine -- merges into whatever's
//   already stored for that week_start)

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const jsonError = (message, status) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const store = getStore("targets-data");

  if (req.method === "GET") {
    const config = (await store.get("config", { type: "json" })) || { weekStartDay: 1 };
    const weekly = (await store.get("weekly", { type: "json" })) || [];
    return new Response(JSON.stringify({ ...config, weekly }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (req.method !== "POST") return jsonError("Use GET or POST", 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError("Body must be JSON", 400);
  }

  if (body.type === "config") {
    if (![0, 1].includes(body.weekStartDay)) return jsonError("weekStartDay must be 0 or 1", 400);
    await store.setJSON("config", { weekStartDay: body.weekStartDay });
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (body.type === "weekly") {
    if (!body.week_start || !/^\d{4}-\d{2}-\d{2}$/.test(body.week_start)) {
      return jsonError("week_start must be YYYY-MM-DD", 400);
    }
    const weekly = (await store.get("weekly", { type: "json" })) || [];
    const idx = weekly.findIndex((w) => w.week_start === body.week_start);
    const fields = ["steps_floor", "steps_target", "sleep_target_min", "sleep_window_start", "sleep_window_end"];
    const updates = {};
    for (const f of fields) if (body[f] !== undefined) updates[f] = body[f];

    if (idx >= 0) {
      weekly[idx] = { ...weekly[idx], ...updates };
    } else {
      weekly.push({ week_start: body.week_start, ...updates });
    }
    weekly.sort((a, b) => a.week_start.localeCompare(b.week_start));
    await store.setJSON("weekly", weekly);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  return jsonError("type must be 'config' or 'weekly'", 400);
};

export const config = {
  path: "/api/targets",
};
