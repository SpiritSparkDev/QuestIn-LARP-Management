export function requireMenu(menuKey) {
  return (handler) => async (ctx) => {
    if (!ctx.user) return { status: 401, body: { error: 'Nicht angemeldet.' } };
    if (!ctx.user.group.visibleMenus.includes(menuKey)) return { status: 403, body: { error: 'Kein Zugriff.' } };
    return handler(ctx);
  };
}

// Allowed when the group has any of the given menus.
export function requireAnyMenu(...menuKeys) {
  return (handler) => async (ctx) => {
    if (!ctx.user) return { status: 401, body: { error: 'Nicht angemeldet.' } };
    if (!menuKeys.some((key) => ctx.user.group.visibleMenus.includes(key))) return { status: 403, body: { error: 'Kein Zugriff.' } };
    return handler(ctx);
  };
}

// Allowed when the group may operate the offline database (admin-assigned permission).
export function requireOfflinePermission(handler) {
  return async (ctx) => {
    if (!ctx.user) return { status: 401, body: { error: 'Nicht angemeldet.' } };
    if (!ctx.user.group.canUseOffline) return { status: 403, body: { error: 'Kein Zugriff.' } };
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
