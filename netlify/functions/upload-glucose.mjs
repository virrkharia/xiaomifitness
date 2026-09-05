// netlify/functions/upload-glucose.mjs
//
// Accepts a raw FreeStyle LibreLink/LibreView export CSV (from
// /glucose-upload.html) and merges it into its own Blobs store,
// completely separate from the Mi Fitness data.
//
// Expected format: first line is a metadata line (ignored), second
// line is the real header, then one row per reading. Only Record Type
// 0 (historic, automatic ~15-min readings) and 1 (manual scan) carry a
// glucose value; other types (e.g. 6, device/connection events) are
// skipped.

import { getStore } from "@netlify/blobs";

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
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "DD-MM-YYYY HH:MM" -> { iso: "YYYY-MM-DDTHH:MM:00", date: "YYYY-MM-DD" }
function parseLibreTimestamp(ts) {
  const m = ts.trim().match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  return {
    iso: `${yyyy}-${mm}-${dd}T${hh}:${min}:00`,
    date: `${yyyy}-${mm}-${dd}`,
  };
}

function computeDailyAggregates(readingsByTimestamp) {
  const byDate = {};
  for (const r of Object.values(readingsByTimestamp)) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r.value);
  }

  const daily = [];
  for (const [date, values] of Object.entries(byDate)) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const inRange = values.filter((v) => v >= 3.9 && v <= 10.0).length;
    const below = values.filter((v) => v < 3.9).length;
    const above = values.filter((v) => v > 10.0).length;

    daily.push({
      date,
      avg_mmol: Math.round(avg * 10) / 10,
      min_mmol: min,
      max_mmol: max,
      reading_count: values.length,
      pct_in_range: Math.round((inRange / values.length) * 100),
      pct_below_range: Math.round((below / values.length) * 100),
      pct_above_range: Math.round((above / values.length) * 100),
    });
  }

  return daily.sort((a, b) => a.date.localeCompare(b.date));
}

export default async (req) => {
  const jsonError = (message, status) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (req.method !== "POST") {
    return jsonError("Use POST with the LibreView CSV text in the body", 405);
  }

  let text = await req.text();
  text = text.replace(/^\uFEFF/, ""); // strip BOM if present

  if (!text.trim()) return jsonError("Empty body", 400);

  const rows = parseCsvRows(text);
  if (rows.length < 3) return jsonError("File doesn't look like a LibreView export", 400);

  // Row 0 is the metadata line, row 1 is the real header.
  const header = rows[1].map((h) => h.trim());
  const idx = {
    timestamp: header.indexOf("Device Timestamp"),
    recordType: header.indexOf("Record Type"),
    historic: header.indexOf("Historic Glucose mmol/L"),
    scan: header.indexOf("Scan Glucose mmol/L"),
  };

  if (idx.timestamp === -1 || idx.recordType === -1) {
    return jsonError("Couldn't find expected LibreView columns in this file", 400);
  }

  const newReadings = {};
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 2) continue;

    const recordType = r[idx.recordType];
    let value = null;
    if (recordType === "0" && idx.historic !== -1) value = parseFloat(r[idx.historic]);
    else if (recordType === "1" && idx.scan !== -1) value = parseFloat(r[idx.scan]);
    if (value === null || Number.isNaN(value)) continue;

    const parsed = parseLibreTimestamp(r[idx.timestamp]);
    if (!parsed) continue;

    newReadings[parsed.iso] = { timestamp: parsed.iso, date: parsed.date, value };
  }

  const importedCount = Object.keys(newReadings).length;
  if (!importedCount) {
    return jsonError("No valid glucose readings found in this file", 400);
  }

  const store = getStore("glucose-data");
  const existingReadingsArr = (await store.get("readings", { type: "json" })) || [];
  const existingReadings = Object.fromEntries(existingReadingsArr.map((r) => [r.timestamp, r]));

  const merged = { ...existingReadings, ...newReadings };
  const mergedArr = Object.values(merged).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  await store.setJSON("readings", mergedArr);
  await store.setJSON("daily", computeDailyAggregates(merged));

  return new Response(
    JSON.stringify({ ok: true, imported: importedCount, total_readings: mergedArr.length }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config = {
  path: "/api/glucose-upload",
};
