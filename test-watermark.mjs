// Standalone local test for the get_aggregated_fitness_data_by_watermark
// endpoint -- likely the one that returns daily steps/sleep rollups.
//
// Usage:
//   node test-watermark.mjs "<ssecurity>" "<cUserId>" "<serviceToken>" "<phone_id>" [watermark]

import crypto from "node:crypto";
import zlib from "node:zlib";

const HOST = "de.hlth.io.mi.com";
const PATH = "/app/v1/data/get_aggregated_fitness_data_by_watermark";

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
  for (let x = 0; x < 1024; x++) step();
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

const [, , ssecurity, cUserId, serviceToken, phoneId, tagArg] = process.argv;
if (!ssecurity || !cUserId || !serviceToken || !phoneId) {
  console.error('Usage: node test-watermark.mjs "<ssecurity>" "<cUserId>" "<serviceToken>" "<phone_id>" [tag]');
  process.exit(1);
}
const tag = tagArg || "daily_fitness";

async function fetchPage(watermark) {
  const nonce = generateNonce();
  const nonceSigned = signedNonce(ssecurity, nonce);

  let params = {
    data: JSON.stringify({ limit: 50, phone_id: phoneId, tag, watermark }),
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
      "User-Agent":
        "Android-17-3.58.0-google-sdk_gphone16k_arm64-f9c4b013bd88d93b1ac929fc5cccbdb5-0d7f7f24c08a85419b2413702d0152e5",
    },
  });

  const bodyText = await res.text();
  if (!res.ok) throw new Error(`Status ${res.status}: ${bodyText.slice(0, 200)}`);

  const decrypted = decryptRc4(nonceSigned, bodyText.trim());
  let text;
  try {
    text = zlib.gunzipSync(decrypted).toString("utf-8");
  } catch {
    text = decrypted.toString("utf-8");
  }
  return JSON.parse(text);
}

const allEntries = [];
let watermark = 0;
let page = 0;

while (page < 40) {
  page++;
  const parsed = await fetchPage(watermark);
  if (parsed.code !== 0) {
    console.log(`Page ${page} error:`, parsed.code, parsed.message);
    break;
  }
  const list = parsed.result?.data_list || [];
  console.log(`Page ${page}: got ${list.length} entries, watermark was ${watermark}`);
  if (!list.length) break;

  allEntries.push(...list);
  const maxWatermark = Math.max(...list.map((i) => i.watermark || 0));
  if (maxWatermark <= watermark) break; // safety: no progress, stop
  watermark = maxWatermark;

  await new Promise((r) => setTimeout(r, 300)); // be polite between calls
}

const fs = await import("node:fs");
fs.writeFileSync(`watermark_response_${tag}.json`, JSON.stringify(allEntries, null, 2));

const keyCounts = {};
for (const item of allEntries) keyCounts[item.key] = (keyCounts[item.key] || 0) + 1;
console.log("\nTag used:", tag);
console.log("Total entries across all pages:", allEntries.length);
console.log("Entries per key:", keyCounts);
console.log(`Full combined response written to watermark_response_${tag}.json`);
