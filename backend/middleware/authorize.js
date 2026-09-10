export function requireMenu(menuKey) {
  return (handler) => async (ctx) => {
    if (!ctx.user) return { status: 401, body: { error: 'Nicht angemeldet.' } };
    if (!ctx.user.group.visibleMenus.includes(menuKey)) return { status: 403, body: { error: 'Kein Zugriff.' } };
    return handler(ctx);
  };
}

export function requireAdminGroup(handler) {
  return async (ctx) => {
    if (!ctx.user) return { status: 401, body: { error: 'Nicht angemeldet.' } };
    if (ctx.user.group.key !== 'admin') return { status: 403, body: { error: 'Kein Zugriff.' } };
    return handler(ctx);
  };
}
