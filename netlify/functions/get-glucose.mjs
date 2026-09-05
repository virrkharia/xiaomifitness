// netlify/functions/get-glucose.mjs
//
// Serves glucose data to the glucose dashboard. By default returns
// daily aggregates (avg/min/max/time-in-range) -- small enough to send
// in full every load. Pass ?date=YYYY-MM-DD to also get that single
// day's raw ~15-min readings, for the intraday curve view.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const store = getStore("glucose-data");
  const daily = (await store.get("daily", { type: "json" })) || [];

  const url = new URL(req.url);
  const date = url.searchParams.get("date");

  let readingsForDate = null;
  if (date) {
    const allReadings = (await store.get("readings", { type: "json" })) || [];
    readingsForDate = allReadings.filter((r) => r.date === date);
  }

  return new Response(JSON.stringify({ daily, readings: readingsForDate }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config = {
  path: "/api/glucose",
};
