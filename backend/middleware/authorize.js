export function requireRole(...roles) {
  return (handler) => async (ctx) => {
    if (!ctx.user) return { status: 401, body: { error: 'not authenticated' } };
    if (!roles.includes(ctx.user.role)) return { status: 403, body: { error: 'forbidden' } };
    return handler(ctx);
  };
}
