// netlify/functions/habits.mjs
//
// Stores habit definitions (supplements, morning/evening routines,
// gym, physio, etc) and daily completion ticks, in their own Blobs
// store, separate from everything else.
//
// GET  /api/habits -> { definitions: [...], completions: {habitId: {date: true}} }
// POST /api/habits with body:
//   { action: "create", name, category, frequency }
//   { action: "update", id, name, category, frequency, active }
//   { action: "delete", id }
//   { action: "toggle", id, date, completed }
//
// frequency shape: { type: "daily" } or { type: "weekly", count: N }

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const jsonError = (message, status) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const store = getStore("habits-data");

  if (req.method === "GET") {
    const definitions = (await store.get("definitions", { type: "json" })) || [];
    const completions = (await store.get("completions", { type: "json" })) || {};
    return new Response(JSON.stringify({ definitions, completions }), {
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

  if (body.action === "create") {
    if (!body.name) return jsonError("name is required", 400);
    const definitions = (await store.get("definitions", { type: "json" })) || [];
    const id = crypto.randomUUID();
    definitions.push({
      id,
      name: body.name,
      category: body.category || "other",
      frequency: body.frequency || { type: "daily" },
      created_date: new Date().toISOString().slice(0, 10),
      active: true,
    });
    await store.setJSON("definitions", definitions);
    return new Response(JSON.stringify({ ok: true, id }), { headers: { "Content-Type": "application/json" } });
  }

  if (body.action === "update") {
    if (!body.id) return jsonError("id is required", 400);
    const definitions = (await store.get("definitions", { type: "json" })) || [];
    const idx = definitions.findIndex((h) => h.id === body.id);
    if (idx < 0) return jsonError("Habit not found", 404);
    const fields = ["name", "category", "frequency", "active"];
    for (const f of fields) if (body[f] !== undefined) definitions[idx][f] = body[f];
    await store.setJSON("definitions", definitions);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (body.action === "delete") {
    if (!body.id) return jsonError("id is required", 400);
    const definitions = (await store.get("definitions", { type: "json" })) || [];
    const filtered = definitions.filter((h) => h.id !== body.id);
    await store.setJSON("definitions", filtered);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (body.action === "toggle") {
    if (!body.id || !body.date) return jsonError("id and date are required", 400);
    const completions = (await store.get("completions", { type: "json" })) || {};
    if (!completions[body.id]) completions[body.id] = {};
    if (body.completed) {
      completions[body.id][body.date] = true;
    } else {
      delete completions[body.id][body.date];
    }
    await store.setJSON("completions", completions);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  return jsonError("Unknown action", 400);
};

export const config = {
  path: "/api/habits",
};
