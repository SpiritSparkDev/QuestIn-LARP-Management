const TRANSITIONS = {
  registered: { checkin: 'checked_in' },
  checked_in: { checkout: 'checked_out' },
  checked_out: {},
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
