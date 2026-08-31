// netlify/functions/get-data.mjs
//
// Serves the stored steps/sleep data to the dashboard page.

import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("mifit-data");
  const days = (await store.get("days", { type: "json" })) || [];

  return new Response(JSON.stringify(days), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};

export const config = {
  path: "/api/data",
};
