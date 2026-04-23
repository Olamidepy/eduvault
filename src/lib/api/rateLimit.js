const buckets = new Map();

export function checkRateLimit(key, { limit = 60, windowMs = 60_000, now = Date.now() } = {}) {
  const bucketKey = String(key || "anonymous");
  const existing = buckets.get(bucketKey);

  if (!existing || existing.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowMs };
    buckets.set(bucketKey, next);
    return { allowed: true, remaining: limit - 1, resetAt: next.resetAt };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfter: Math.ceil((existing.resetAt - now) / 1000),
  };
}

export function resetRateLimits() {
  buckets.clear();
}
