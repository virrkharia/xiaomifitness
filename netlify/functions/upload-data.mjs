// netlify/functions/upload-data.mjs
//
// Accepts a CSV upload (from the /upload.html page) and merges it into
// the same Netlify Blobs store the automated pull-data function uses.
//
// Two input formats are accepted, auto-detected from the header row:
//
// 1. Xiaomi's own raw export file, straight from account.xiaomi.com's
//    "download a copy" feature -- columns:
//      Uid,Sid,Tag,Key,Time,Value,UpdateTime
//    where Value is a JSON blob whose shape depends on Key (steps, sleep,
//    calories, etc). This is parsed and converted automatically.
//
// 2. A simple pre-shaped CSV, only date and steps required:
//      date,steps,sleep_total_min,sleep_deep_min,sleep_light_min,distance_m,calories
//    (date as YYYY-MM-DD)

import { getStore } from "@netlify/blobs";

// RFC4180-ish CSV parser: handles quoted fields containing commas, quotes
// (escaped as ""), and newlines -- needed because Xiaomi's export embeds
// raw JSON (with commas and quotes) inside CSV cells.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function rowsToObjects(rows) {
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => (obj[h] = r[idx]));
    return obj;
  });
}

function toNumberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function unixToDateString(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

// Format 1: Xiaomi's raw export (Uid,Sid,Tag,Key,Time,Value,UpdateTime)
function parseXiaomiExport(rows) {
  const objs = rowsToObjects(rows);
  const stepsByDate = {};
  const sleepByDate = {};

  for (const row of objs) {
    const time = Number(row.Time);
    if (!Number.isFinite(time)) continue;
    const date = unixToDateString(time);

    let val;
    try {
      val = JSON.parse(row.Value);
    } catch {
      continue;
    }

    if (row.Key === "steps" && "steps" in val) {
      stepsByDate[date] = val;
    }
    if (row.Key === "sleep" && "total_duration" in val) {
      sleepByDate[date] = val;
    }
  }

  const allDates = new Set([...Object.keys(stepsByDate), ...Object.keys(sleepByDate)]);
  const parsed = {};

  for (const date of allDates) {
    const s = stepsByDate[date] || {};
    const sl = sleepByDate[date] || {};
    const deep = sl.sleep_deep_duration || 0;
    const light = sl.sleep_light_duration || 0;

    parsed[date] = {
      date,
      steps: s.steps || 0,
      distance_m: s.distance || 0,
      calories: s.calories || 0,
      sleep_total_min: sl.total_duration || deep + light,
      sleep_deep_min: deep,
      sleep_light_min: light,
      sleep_start: null,
      sleep_end: null,
    };
  }

  return parsed;
}

// Format 2: simple pre-shaped CSV
function parseSimpleCsv(rows) {
  const objs = rowsToObjects(rows);
  const parsed = {};

  for (const row of objs) {
    if (!row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;

    const deepMin = toNumberOrZero(row.sleep_deep_min);
    const lightMin = toNumberOrZero(row.sleep_light_min);
    const total = row.sleep_total_min ? toNumberOrZero(row.sleep_total_min) : deepMin + lightMin;

    parsed[row.date] = {
      date: row.date,
      steps: toNumberOrZero(row.steps),
      distance_m: toNumberOrZero(row.distance_m),
      calories: toNumberOrZero(row.calories),
      sleep_total_min: total,
      sleep_deep_min: deepMin,
      sleep_light_min: lightMin,
      sleep_start: null,
      sleep_end: null,
    };
  }

  return parsed;
}

export default async (req) => {
  const jsonError = (message, status) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (req.method !== "POST") {
    return jsonError("Use POST with CSV text in the body", 405);
  }

  const text = await req.text();
  if (!text.trim()) {
    return jsonError("Empty body", 400);
  }

  let rows;
  try {
    rows = parseCsvRows(text);
  } catch (err) {
    return jsonError(`Couldn't parse CSV: ${err.message}`, 400);
  }

  if (rows.length < 2) {
    return jsonError("No data rows found in file", 400);
  }

  const header = rows[0].map((h) => h.trim());
  const isXiaomiExport = header.includes("Key") && header.includes("Value") && header.includes("Time");

  let parsed;
  try {
    parsed = isXiaomiExport ? parseXiaomiExport(rows) : parseSimpleCsv(rows);
  } catch (err) {
    return jsonError(`Couldn't process file: ${err.message}`, 400);
  }

  if (!Object.keys(parsed).length) {
    return jsonError(
      isXiaomiExport
        ? "No steps/sleep entries found in this export"
        : "No valid rows found (check date format is YYYY-MM-DD)",
      400
    );
  }

  const store = getStore("mifit-data");
  const existingArr = (await store.get("days", { type: "json" })) || [];
  const existing = Object.fromEntries(existingArr.map((d) => [d.date, d]));

  const merged = { ...existing, ...parsed };
  const mergedArr = Object.values(merged).sort((a, b) => a.date.localeCompare(b.date));

  await store.setJSON("days", mergedArr);

  return new Response(
    JSON.stringify({
      ok: true,
      format: isXiaomiExport ? "xiaomi-export" : "simple-csv",
      imported: Object.keys(parsed).length,
      total: mergedArr.length,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config = {
  path: "/api/upload",
};
