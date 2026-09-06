const TRANSITIONS = {
  pending: { approve: 'confirmed', cancel: 'cancelled' },
  confirmed: { checkin: 'checked_in', cancel: 'cancelled' },
  checked_in: { checkout: 'checked_out' },
  checked_out: {},
  cancelled: {},
};

export function applyTransition(currentStatus, action) {
  const next = TRANSITIONS[currentStatus]?.[action];
  if (!next) {
    const err = new Error(`invalid transition: cannot ${action} from status "${currentStatus}"`);
    err.code = 'INVALID_TRANSITION';
    throw err;
  }
  return next;
}
