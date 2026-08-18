// =============================================================================
// Login guard — failed-attempt lockout plus a gate on scrypt concurrency
// =============================================================================
// Two counters per target so brute force is stopped even when the attacker's
// real IP is hidden behind a proxy:
//
//   per-IP       keyed by "ip|target" — precise when req.ip is meaningful
//   per-target   keyed by target alone — the backstop, and the whole story
//                when everything arrives from one gateway (Docker + tunnel)
//
// Both fail closed to a lockout: after MAX_FAILURES inside WINDOW_MS the
// target stops accepting attempts (429) until the window slides past.
// Counters live only in memory on purpose: surviving a restart isn't worth
// the machinery, and a lockout that expires in 15 minutes self-heals.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const IP_MAX_FAILURES = 5;
const TARGET_MAX_FAILURES = 20;
const MAX_ENTRIES = 20_000; // hard cap, so a flood of spoofed IPs can't grow memory

const perIp = new Map(); // "ip|target" -> { count, firstFailureAt }
const perTarget = new Map(); // target -> { count, firstFailureAt }

// ---- scrypt gate -------------------------------------------------------------
// scrypt is async now, but a flood of parallel attempts would still pin the
// CPU with every in-flight hash holding it for ~50 ms. Cap concurrency and
// refuse excess attempts with a quick 503 instead of queueing forever.

const VERIFY_CONCURRENCY = 4;
const VERIFY_MAX_QUEUE = 64;

let active = 0;
let queueLength = 0;
const waiters = [];

/** Resolve true when a verification slot is available, false when the server
 *  is too busy to queue the attempt. Call releaseGate() after the check. */
function acquireGate() {
  if (active < VERIFY_CONCURRENCY) {
    active += 1;
    return Promise.resolve(true);
  }
  if (queueLength >= VERIFY_MAX_QUEUE) return Promise.resolve(false);
  queueLength += 1;
  return new Promise((resolve) => {
    waiters.push(() => {
      queueLength -= 1;
      active += 1;
      resolve(true);
    });
  });
}

function releaseGate() {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

// ---- Lockout state ------------------------------------------------------------

function prune(map, nowMs) {
  for (const [key, entry] of map) {
    if (nowMs - entry.firstFailureAt >= WINDOW_MS) map.delete(key);
  }
}

/** Seconds until this map's key is unlocked, or 0 if it isn't locked. */
function lockoutSeconds(map, key, max, nowMs) {
  const entry = map.get(key);
  if (!entry) return 0;
  if (nowMs - entry.firstFailureAt >= WINDOW_MS) {
    map.delete(key);
    return 0;
  }
  if (entry.count < max) return 0;
  return Math.ceil((WINDOW_MS - (nowMs - entry.firstFailureAt)) / 1000);
}

/**
 * Cheap pre-check to run before any password work (and before scrypt).
 * Returns { blocked, retryAfterSec } — retryAfterSec only when blocked.
 */
function check(ip, target) {
  const nowMs = Date.now();
  const ipRetry = lockoutSeconds(perIp, `${ip}|${target}`, IP_MAX_FAILURES, nowMs);
  if (ipRetry) return { blocked: true, retryAfterSec: ipRetry };
  const targetRetry = lockoutSeconds(perTarget, target, TARGET_MAX_FAILURES, nowMs);
  if (targetRetry) return { blocked: true, retryAfterSec: targetRetry };
  return { blocked: false, retryAfterSec: 0 };
}

function recordFailure(ip, target) {
  const nowMs = Date.now();
  bump(perIp, `${ip}|${target}`, nowMs);
  bump(perTarget, target, nowMs);
}

/** A correct password proves legitimacy, so clear this target's failures. */
function recordSuccess(ip, target) {
  perIp.delete(`${ip}|${target}`);
  perTarget.delete(target);
}

function bump(map, key, nowMs) {
  const entry = map.get(key);
  if (entry && nowMs - entry.firstFailureAt < WINDOW_MS) {
    entry.count += 1;
    return;
  }
  if (map.size >= MAX_ENTRIES) prune(map, nowMs);
  if (map.size >= MAX_ENTRIES) return; // full: skip tracking, keep serving
  map.set(key, { count: 1, firstFailureAt: nowMs });
}

/** Periodic sweep so entries from long-gone IPs don't linger. */
function startCleanup() {
  const timer = setInterval(() => {
    const nowMs = Date.now();
    prune(perIp, nowMs);
    prune(perTarget, nowMs);
  }, 5 * 60 * 1000);
  timer.unref();
}

module.exports = {
  check,
  recordFailure,
  recordSuccess,
  acquireGate,
  releaseGate,
  startCleanup,
};
