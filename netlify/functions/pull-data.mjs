// netlify/functions/pull-data.mjs
//
// Pulls steps + sleep from Mi Fitness's current backend (de.hlth.io.mi.com)
// using Xiaomi's standard signed-request scheme (the same one used by Mi
// Home, Mi Band, and other Xiaomi cloud services -- this is NOT specific to
// this project; see PiotrMachowski/Xiaomi-cloud-tokens-extractor on GitHub
// for the reference implementation this was ported from).
//
// This deliberately reuses an already-authenticated session (ssecurity +
// cUserId + serviceToken captured once from your own phone/emulator)
// rather than logging in -- see docs/capture-token.md. No login event
// happens here, so there's nothing for Xiaomi's fraud detection to flag.
//
// Required environment variables (set in Netlify site settings):
//   MIFIT_SSECURITY     - captured from the sid=miothealth login response
//   MIFIT_CUSERID       - captured from the same response / request cookies
//   MIFIT_SERVICETOKEN  - captured from a de.hlth.io.mi.com request's Cookie header

import crypto from "node:crypto";
import zlib from "node:zlib";
import { getStore } from "@netlify/blobs";

const HOST = "de.hlth.io.mi.com";
const PATH = "/app/v1/data/get_fitness_data_by_time";

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

// --- Building and sending one signed request ---

async function fetchFitnessData(ssecurity, cUserId, serviceToken, startTimeUnixSeconds) {
  const nonce = generateNonce();
  const nonceSigned = signedNonce(ssecurity, nonce);

  let params = {
    data: JSON.stringify({ start_time: startTimeUnixSeconds, end_time: 0, reverse: true }),
  };

  params.rc4_hash__ = generateEncSignature("GET", PATH, nonceSigned, params);
  for (const k of Object.keys(params)) {
    params[k] = encryptRc4(nonceSigned, params[k]);
  }
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
    },
  });

  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} -- ${bodyText.slice(0, 300)}`);
  }

  const decrypted = decryptRc4(nonceSigned, bodyText.trim());

  // Some Xiaomi endpoints gzip the payload before encrypting it -- try that
  // first, fall back to plain text.
  let text;
  try {
    text = zlib.gunzipSync(decrypted).toString("utf-8");
  } catch {
    text = decrypted.toString("utf-8");
  }

  return JSON.parse(text);
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async () => {
  const ssecurity = process.env.MIFIT_SSECURITY;
  const cUserId = process.env.MIFIT_CUSERID;
  const serviceToken = process.env.MIFIT_SERVICETOKEN;

  if (!ssecurity || !cUserId || !serviceToken) {
    console.error("MIFIT_SSECURITY / MIFIT_CUSERID / MIFIT_SERVICETOKEN are not set");
    return new Response("Missing credentials", { status: 500 });
  }

  const startTime = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  try {
    const data = await fetchFitnessData(ssecurity, cUserId, serviceToken, startTime);

    // First-run visibility: log the raw shape so we can confirm/adjust the
    // parsing below against what this endpoint actually returns.
    console.log("Raw decrypted response:", JSON.stringify(data).slice(0, 2000));

    // TODO once we've seen a real response: map `data` into per-day
    // {date, steps, sleep_total_min, sleep_deep_min, sleep_light_min}
    // objects and merge into the "days" key in Blobs, the same way the
    // manual CSV importer does.

    return new Response("OK -- check function logs for the raw response shape");
  } catch (err) {
    console.error("Pull failed:", err.message);
    return new Response(`Pull failed: ${err.message}`, { status: 500 });
  }
};

export const config = {
  schedule: "15 6 * * *",
};
