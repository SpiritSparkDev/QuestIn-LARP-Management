// Idempotency key for a booking the user may trigger more than once (double
// tap, or a retry after the answer got lost on a bad connection). The same
// key is reused for the same action until it succeeded, so the server books
// it only once; a different action (other cart, other amount) gets a new key.

export function newRequestId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // randomUUID needs a secure context; getRandomValues does not (plain-http LAN).
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createRequestKeys() {
  let pending = null;
  return {
    get(signature) {
      if (!pending || pending.signature !== signature) pending = { signature, id: newRequestId() };
      return pending.id;
    },
    done() { pending = null; },
  };
}
