const buckets = new Map();

// In-memory, single-instance limiter — correct for this app's deployment
// (one `app` service in docker-compose.yml, no shared/multi-instance
// state needed). Buckets for keys that stop being used aren't evicted
// immediately, but `isRateLimited` sweeps expired entries out once the map
// grows large (see below), so memory stays bounded even under a distributed
// attack that mints many short-lived keys (e.g. many emails/IPs).
export function isRateLimited(key, maxAttempts, windowMs, now = Date.now()) {
  if (buckets.size > 10_000) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.windowStart >= windowMs) {
        buckets.delete(bucketKey);
      }
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  if (bucket.count >= maxAttempts) {
    return true;
  }
  bucket.count += 1;
  return false;
}

// Test-only: clears all buckets so each test starts with a clean rate-limit
// slate instead of sharing state with every other test in the same file.
export function resetRateLimits() {
  buckets.clear();
}

export function rateLimit({ keyPrefix, maxAttempts, windowMs }) {
  return (handler) => async (ctx) => {
    // ponytail: assumes the app is reached directly (true today — see
    // docker-compose.yml, no reverse proxy in front). Behind a proxy this
    // collapses every client into the proxy's one IP. Upgrade path: a
    // TRUST_PROXY-style env gate that trusts a configured number of
    // X-Forwarded-For hops, not a naive "trust the header" read.
    const ip = ctx.req.socket.remoteAddress || 'unknown';
    if (isRateLimited(`${keyPrefix}:${ip}`, maxAttempts, windowMs)) {
      return { status: 429, body: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' } };
    }
    return handler(ctx);
  };
}
