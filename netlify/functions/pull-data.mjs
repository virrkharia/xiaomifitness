// netlify/functions/pull-data.mjs
//
// Scheduled Netlify Function. Logs into a Xiaomi Mi Fitness / Mi Fit
// account, pulls the last 7 days of steps + sleep, and merges it into
// Netlify Blobs storage.
//
// This uses the same (unofficial, reverse-engineered) endpoints the Mi
// Fit / Mi Fitness Android app itself calls. It is not an official
// Xiaomi or Netlify integration and can break if Xiaomi changes their
// backend. Only use it with your own account.
//
// Required environment variables (set in Netlify site settings):
//   MIFIT_EMAIL     - the email you sign into Mi Fitness with
//   MIFIT_PASSWORD  - the password for that account

import { getStore } from "@netlify/blobs";

const APP_NAME = "com.xiaomi.hm.health";
const APP_VERSION = "4.0.9";
const DEVICE_ID = "02:00:00:00:00:00";

async function login(email, password) {
  const encodedEmail = encodeURIComponent(email);

  const step1 = await fetch(
    `https://api-user.huami.com/registrations/${encodedEmail}/tokens`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        state: "REDIRECTION",
        client_id: "HuaMi",
        redirect_uri:
          "https://s3-us-west-2.amazonws.com/hm-registration/successsignin.html",
        token: "access",
        password,
      }),
    }
  );

  const location = step1.headers.get("location");
  if (!location) {
    throw new Error(
      `Login step 1 failed (status ${step1.status}, no redirect). Check your email/password.`
    );
  }

  const redirectUrl = new URL(location);
  const params = redirectUrl.search
    ? redirectUrl.searchParams
    : new URLSearchParams(redirectUrl.hash.replace(/^#/, ""));

  const accessToken = params.get("access");
  const countryCode = params.get("country_code") || "GB";
  if (!accessToken) {
    throw new Error(`Login step 1 did not return an access token. Redirect: ${location}`);
  }

  const step2res = await fetch("https://account.huami.com/v2/client/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      app_name: APP_NAME,
      dn: "account.huami.com,api-user.huami.com,api-watch.huami.com,api-analytics.huami.com,app-analytics.huami.com,api-mifit.huami.com",
      device_id: DEVICE_ID,
      device_model: "android_phone",
      app_version: APP_VERSION,
      allow_registration: "false",
      third_name: "huami",
      grant_type: "access_token",
      country_code: countryCode,
      code: accessToken,
    }),
  });

  const creds = await step2res.json();
  if (!creds.token_info) {
    throw new Error(`Login step 2 did not return credentials: ${JSON.stringify(creds)}`);
  }

  return { appToken: creds.token_info.app_token, userId: creds.token_info.user_id };
}

async function fetchBandData(appToken, userId, fromDate, toDate) {
  const url = new URL("https://api-mifit.huami.com/v1/data/band_data.json");
  url.searchParams.set("query_type", "summary");
  url.searchParams.set("device_type", "android_phone");
  url.searchParams.set("userid", userId);
  url.searchParams.set("from_date", fromDate);
  url.searchParams.set("to_date", toDate);

  const res = await fetch(url, { headers: { apptoken: appToken } });
  if (!res.ok) throw new Error(`band_data.json request failed: ${res.status}`);
  return res.json();
}

function parseDay(entry) {
  const summaryB64 = entry.summary;
  if (!summaryB64) return null;

  let summary;
  try {
    summary = JSON.parse(Buffer.from(summaryB64, "base64").toString("utf-8"));
  } catch {
    return null;
  }

  const stp = summary.stp || {};
  const slp = summary.slp || {};
  const deepMin = slp.dp || 0;
  const lightMin = slp.lt || 0;

  return {
    date: entry.date_time || entry.date,
    steps: stp.ttl || 0,
    distance_m: stp.dis || 0,
    calories: stp.cal || 0,
    sleep_total_min: deepMin + lightMin,
    sleep_deep_min: deepMin,
    sleep_light_min: lightMin,
    sleep_start: slp.st ?? null,
    sleep_end: slp.ed ?? null,
  };
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async () => {
  const email = process.env.MIFIT_EMAIL;
  const password = process.env.MIFIT_PASSWORD;

  if (!email || !password) {
    console.error("MIFIT_EMAIL / MIFIT_PASSWORD are not set");
    return new Response("Missing credentials", { status: 500 });
  }

  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  try {
    console.log(`Logging in as ${email}...`);
    const { appToken, userId } = await login(email, password);

    console.log("Pulling band data...");
    const raw = await fetchBandData(appToken, userId, formatDate(weekAgo), formatDate(today));
    const entries = raw.data || [];

    const parsed = {};
    for (const entry of entries) {
      const day = parseDay(entry);
      if (day && day.date) parsed[day.date] = day;
    }

    const store = getStore("mifit-data");
    const existingArr = (await store.get("days", { type: "json" })) || [];
    const existing = Object.fromEntries(existingArr.map((d) => [d.date, d]));

    const merged = { ...existing, ...parsed };
    const mergedArr = Object.values(merged).sort((a, b) => a.date.localeCompare(b.date));

    await store.setJSON("days", mergedArr);

    console.log(`Stored ${mergedArr.length} days total (${Object.keys(parsed).length} updated)`);
    return new Response("OK");
  } catch (err) {
    console.error("Pull failed:", err.message);
    return new Response(`Pull failed: ${err.message}`, { status: 500 });
  }
};

export const config = {
  schedule: "15 6 * * *", // 06:15 UTC daily — edit to change the time
};
