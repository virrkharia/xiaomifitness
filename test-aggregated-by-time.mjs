// Standalone local test for get_aggregated_fitness_data_by_time.
//
// Usage:
//   node test-aggregated-by-time.mjs "<ssecurity>" "<cUserId>" "<serviceToken>"

import crypto from "node:crypto";
import zlib from "node:zlib";

const HOST = "de.hlth.io.mi.com";
const PATH = "/app/v1/data/get_aggregated_fitness_data_by_time";

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

const [, , ssecurity, cUserId, serviceToken] = process.argv;
if (!ssecurity || !cUserId || !serviceToken) {
  console.error('Usage: node test-aggregated-by-time.mjs "<ssecurity>" "<cUserId>" "<serviceToken>"');
  process.exit(1);
}

const nonce = generateNonce();
const nonceSigned = signedNonce(ssecurity, nonce);

let params = {
  data: JSON.stringify({ limit: 100, reverse: true, tag: "daily_mark" }),
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
console.log("Status:", res.status);

if (!res.ok) {
  console.log("Error body:", bodyText.slice(0, 300));
  process.exit(1);
}

const decrypted = decryptRc4(nonceSigned, bodyText.trim());
let text;
try {
  text = zlib.gunzipSync(decrypted).toString("utf-8");
} catch {
  text = decrypted.toString("utf-8");
}
console.log("Decrypted response:\n", text.slice(0, 4000));
