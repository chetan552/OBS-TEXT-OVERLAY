// =============================================================================
// Auth primitives — password hashing, signed cookies, cookie parsing
// =============================================================================
// No external dependencies: everything here is built on node:crypto.
//
//   Passwords  -> scrypt with a per-password random salt.
//   Sessions   -> stateless HMAC-signed tokens ("<payload>.<signature>").
//                 Nothing is stored server-side, so sessions survive a
//                 restart as long as the signing secret does.

const crypto = require("crypto");

// ---- Password hashing -------------------------------------------------------
// scrypt parameters. N=16384 keeps verification around ~50 ms on a Mac mini,
// which is slow enough to make offline guessing expensive but fast enough
// that a login never feels sluggish.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

/**
 * Hash a plaintext password into a self-describing string:
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 * The parameters are embedded so old hashes stay verifiable if we tune them.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/**
 * Verify a plaintext password against a stored hash. Always compares in
 * constant time, and never throws on malformed input — a bad hash string
 * simply fails to verify.
 */
function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---- Random tokens ----------------------------------------------------------

/**
 * A URL-safe random token. 32 bytes = 256 bits, so a view token is not
 * guessable even though it travels in a plain URL that gets pasted into OBS.
 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// ---- Signed session tokens --------------------------------------------------

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Create a stateless session token carrying `claims` plus an expiry.
 * Format: "<base64url(json)>.<base64url(hmac)>"
 */
function signSession(claims, secret, maxAgeSeconds) {
  const payload = base64urlJson({
    ...claims,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
  });
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

/**
 * Verify a session token and return its claims, or null if the token is
 * malformed, tampered with, or expired.
 */
function verifySession(token, secret) {
  if (typeof token !== "string") return null;

  const dot = token.indexOf(".");
  if (dot === -1) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (signature.length !== expected.length) return null;
  if (
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof claims.exp !== "number" || claims.exp < Date.now() / 1000) {
    return null;
  }
  return claims;
}

// ---- Cookies ----------------------------------------------------------------

/**
 * Parse a Cookie header into a plain object. Returns {} for a missing or
 * unparseable header rather than throwing — callers treat a missing cookie
 * and a broken cookie identically.
 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(pair.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape shouldn't discard the whole header.
      out[name] = pair.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Build a Set-Cookie value. `secure` is decided per-request (LAN is http). */
function serializeCookie(name, value, { maxAge, secure, path = "/" }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (typeof maxAge === "number") parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

module.exports = {
  hashPassword,
  verifyPassword,
  randomToken,
  signSession,
  verifySession,
  parseCookies,
  serializeCookie,
};
