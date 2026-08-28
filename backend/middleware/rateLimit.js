const buckets = new Map();

// In-memory, single-instance limiter — correct for this app's deployment
// (one `app` service in docker-compose.yml, no shared/multi-instance
// state needed). Buckets for keys that stop being used are never evicted;
// at this app's scale (a LARP registration tool, not a public high-traffic
// service) that's an acceptable tradeoff, not a real memory leak risk.
export function isRateLimited(key, maxAttempts, windowMs, now = Date.now()) {
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

export function rateLimit({ keyPrefix, maxAttempts, windowMs }) {
  return (handler) => async (ctx) => {
    const ip = ctx.req.socket.remoteAddress || 'unknown';
    if (isRateLimited(`${keyPrefix}:${ip}`, maxAttempts, windowMs)) {
      return { status: 429, body: { error: 'too many requests, please try again later' } };
    }
    return handler(ctx);
  };
}
