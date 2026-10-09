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

// The address of the visitor. Behind a reverse proxy (Plesk/nginx, Caddy) the socket only shows the proxy, so every
// visitor would share one bucket. TRUST_PROXY=<number of proxies in front of the app> reads the client address
// from the end of X-Forwarded-For: the last entries were added by our own proxies, the one before them is the
// client; anything a visitor puts in front of that is ignored. Unset/0: the socket address (direct access).
export function clientIp(req) {
  const socketIp = req.socket?.remoteAddress || 'unknown';
  const hops = Number.parseInt(process.env.TRUST_PROXY ?? '0', 10);
  if (!(hops > 0)) return socketIp;
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  return forwarded.length >= hops ? forwarded[forwarded.length - hops] : socketIp;
}

// RATE_LIMIT_DISABLED=1 switches off the per-address limits of every route that uses this middleware. The
// per-account lock of a login (5 wrong tries per e-mail) is a separate check and stays.
const limitsDisabled = () => ['1', 'true', 'yes', 'on'].includes(String(process.env.RATE_LIMIT_DISABLED ?? '').toLowerCase());

export function rateLimit({ keyPrefix, maxAttempts, windowMs }) {
  return (handler) => async (ctx) => {
    if (limitsDisabled()) return handler(ctx);
    const ip = clientIp(ctx.req);
    if (isRateLimited(`${keyPrefix}:${ip}`, maxAttempts, windowMs)) {
      return { status: 429, body: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' } };
    }
    return handler(ctx);
  };
}
