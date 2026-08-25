const MAX_BODY_BYTES = 1_000_000;

export function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('error', () => finish(null));
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return finish({});
      try {
        finish(JSON.parse(data));
      } catch {
        finish(null);
      }
    });
  });
}
