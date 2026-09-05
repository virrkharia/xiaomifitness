// netlify/functions/pull-data.mjs
//
// Pulls steps + sleep from Mi Fitness's backend (de.hlth.io.mi.com) using
// Xiaomi's signed-request scheme (the same one used by Mi Home, Mi Band,
// etc -- see PiotrMachowski/Xiaomi-cloud-tokens-extractor on GitHub for
// the reference implementation this was ported from).
//
// This reuses an already-authenticated session (ssecurity + cUserId +
// serviceToken + phone_id captured once from your own phone/emulator --
// see docs/capture-token.md) rather than logging in, so there's no login
// event for Xiaomi's fraud detection to flag.
//
// It calls get_aggregated_fitness_data_by_watermark with tag=daily_report,
// which returns per-day steps/sleep/calories entries. Results are paged
// using an opaque "watermark" cursor: each call returns up to 50 entries
// and the highest watermark seen becomes the starting point for the next
// call. The last-seen watermark is stored in Blobs so each run only pulls
// what's new since last time -- the very first run has no stored
// watermark, so it starts at 0 and pulls your entire history.
//
// Required environment variables (set in Netlify site settings):
//   MIFIT_SSECURITY     - captured from the sid=miothealth login response
//   MIFIT_CUSERID       - captured from the same response / request cookies
//   MIFIT_SERVICETOKEN  - captured from a de.hlth.io.mi.com request's Cookie header
//   MIFIT_PHONE_ID      - captured from a get_aggregated_fitness_data_by_watermark request's decrypted body

import crypto from "node:crypto";
import zlib from "node:zlib";
import { getStore } from "@netlify/blobs";

const HOST = "de.hlth.io.mi.com";
const PATH = "/app/v1/data/get_aggregated_fitness_data_by_watermark";
const PAGE_LIMIT = 50;
const MAX_PAGES = 40;

// --- Xiaomi signing primitives (ported from Xiaomi-cloud-tokens-extractor) ---

function signedNonce(ssecurityB64, nonceB64) {
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from(ssecurityB64, "base64"), Buffer.from(nonceB64, "base64")]))
    .digest();
  return hash.toString("base64");
}

function generateNonce() {
  const millis = Date.now();
  const random = crypto.randomBytes(8);
  const minutes = Buffer.alloc(4);
  minutes.writeUInt32BE(Math.floor(millis / 60000));
  return Buffer.concat([random, minutes]).toString("base64");
}

// Pure-JS RC4 with the 1024 "fake round" warm-up Xiaomi's scheme uses.
// (Implemented manually rather than via Node's crypto module, since RC4
// is disabled by default in some OpenSSL 3 builds.)
function rc4(keyB64, inputBuffer) {
  const key = Buffer.from(keyB64, "base64");
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
  }

  let i = 0;
  j = 0;
  const step = () => {
    i = (i + 1) % 256;
    j = (j + S[i]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
    return S[(S[i] + S[j]) % 256];
  };

  for (let x = 0; x < 1024; x++) step(); // warm-up, discarded

  const out = Buffer.alloc(inputBuffer.length);
  for (let x = 0; x < inputBuffer.length; x++) out[x] = inputBuffer[x] ^ step();
  return out;
}

function encryptRc4(signedNonceB64, plaintext) {
  return rc4(signedNonceB64, Buffer.from(plaintext, "utf-8")).toString("base64");
}

function decryptRc4(signedNonceB64, ciphertextB64) {
  return rc4(signedNonceB64, Buffer.from(ciphertextB64, "base64"));
}

function generateEncSignature(method, urlPath, signedNonceB64, params) {
  const parts = [method.toUpperCase(), urlPath];
  for (const [k, v] of Object.entries(params)) parts.push(`${k}=${v}`);
  parts.push(signedNonceB64);
  return crypto.createHash("sha1").update(parts.join("&"), "utf-8").digest("base64");
}

const USER_AGENT =
  "Android-17-3.58.0-google-sdk_gphone16k_arm64-f9c4b013bd88d93b1ac929fc5cccbdb5-0d7f7f24c08a85419b2413702d0152e5";

async function fetchWatermarkPage(creds, watermark) {
  const { ssecurity, cUserId, serviceToken, phoneId } = creds;
  const nonce = generateNonce();
  const nonceSigned = signedNonce(ssecurity, nonce);

  let params = {
    data: JSON.stringify({ limit: PAGE_LIMIT, phone_id: phoneId, tag: "daily_report", watermark }),
  };
  params.rc4_hash__ = generateEncSignature("GET", PATH, nonceSigned, params);
  for (const k of Object.keys(params)) params[k] = encryptRc4(nonceSigned, params[k]);
  params.signature = generateEncSignature("GET", PATH, nonceSigned, params);
  params.ssecurity = ssecurity;
  params._nonce = nonce;

  const url = new URL(`https://${HOST}${PATH}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      Cookie: `cUserId=${cUserId}; serviceToken=${serviceToken}; locale=en_us`,
      HandleParams: "true",
      region_tag: "de",
      Host: HOST,
      "User-Agent": USER_AGENT,
    },
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} -- ${bodyText.slice(0, 300)}`);
  }

  const decrypted = decryptRc4(nonceSigned, bodyText.trim());
  let text;
  try {
    text = zlib.gunzipSync(decrypted).toString("utf-8");
  } catch {
    text = decrypted.toString("utf-8");
  }

  const parsed = JSON.parse(text);
  if (parsed.code !== 0) {
    throw new Error(`API error ${parsed.code}: ${parsed.message}`);
  }
  return parsed.result?.data_list || [];
}

function unixToDateString(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function mergeEntriesIntoDays(entries, days) {
  const trackedKeys = new Set([
    "steps",
    "sleep",
    "heart_rate",
    "intensity",
    "valid_stand",
    "calories",
    "stress",
    "spo2",
  ]);

  for (const entry of entries) {
    if (!trackedKeys.has(entry.key)) continue;

    let val;
    try {
      val = JSON.parse(entry.value);
    } catch {
      continue;
    }

    const date = unixToDateString(entry.time);
    const existing = days[date] || {
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

    // Keep the full raw value too, for drill-down and future charts --
    // never lose data the API gave us just because today's summary
    // view doesn't use a field yet.
    if (!existing.raw) existing.raw = {};
    existing.raw[entry.key] = val;

    if (entry.key === "steps" && "steps" in val) {
      existing.steps = val.steps || 0;
      existing.distance_m = val.distance || 0;
      existing.calories = val.calories || 0;
    }

    if (entry.key === "sleep" && "total_duration" in val) {
      existing.sleep_total_min = val.total_duration || 0;
      existing.sleep_deep_min = val.sleep_deep_duration || 0;
      existing.sleep_light_min = val.sleep_light_duration || 0;
    }

    days[date] = existing;
  }
}

export default async () => {
  const ssecurity = process.env.MIFIT_SSECURITY;
  const cUserId = process.env.MIFIT_CUSERID;
  const serviceToken = process.env.MIFIT_SERVICETOKEN;
  const phoneId = process.env.MIFIT_PHONE_ID;

  if (!ssecurity || !cUserId || !serviceToken || !phoneId) {
    console.error("MIFIT_SSECURITY / MIFIT_CUSERID / MIFIT_SERVICETOKEN / MIFIT_PHONE_ID are not set");
    return new Response("Missing credentials", { status: 500 });
  }

  const creds = { ssecurity, cUserId, serviceToken, phoneId };
  const store = getStore("mifit-data");

  // Set MIFIT_RESET=true as a Netlify env var to force a full re-pull
  // from the beginning (e.g. after adding a new tracked field) -- set
  // it back to false/unset afterwards so subsequent runs stay
  // incremental again.
  const forceReset = process.env.MIFIT_RESET === "true";

  let watermark = forceReset ? "0" : (await store.get("watermark", { type: "text" })) || "0";
  watermark = Number(watermark);

  const existingArr = (await store.get("days", { type: "json" })) || [];
  const days = Object.fromEntries(existingArr.map((d) => [d.date, d]));

  let totalEntries = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const entries = await fetchWatermarkPage(creds, watermark);
      if (!entries.length) break;

      totalEntries += entries.length;
      mergeEntriesIntoDays(entries, days);

      const maxWatermark = Math.max(...entries.map((e) => e.watermark || 0));
      if (maxWatermark <= watermark) break; // safety: no progress
      watermark = maxWatermark;

      if (entries.length < PAGE_LIMIT) break; // last page
      await new Promise((r) => setTimeout(r, 300)); // be polite between calls
    }
  } catch (err) {
    console.error("Pull failed:", err.message);
    return new Response(`Pull failed: ${err.message}`, { status: 500 });
  }

  const mergedArr = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
  await store.setJSON("days", mergedArr);
  await store.set("watermark", String(watermark));

  console.log(`Pulled ${totalEntries} entries, store now has ${mergedArr.length} days, watermark=${watermark}`);
  return new Response(`OK -- pulled ${totalEntries} entries, ${mergedArr.length} days total`);
};

export const config = {
  schedule: "15 6 * * *",
};
