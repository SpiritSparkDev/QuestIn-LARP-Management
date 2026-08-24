function compilePattern(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const { regex, paramNames } = compilePattern(pattern);
    this.routes.push({ method: method.toUpperCase(), regex, paramNames, handler });
  }

  get(pattern, handler) { this.add('GET', pattern, handler); }
  post(pattern, handler) { this.add('POST', pattern, handler); }
  put(pattern, handler) { this.add('PUT', pattern, handler); }
  delete(pattern, handler) { this.add('DELETE', pattern, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
      return { handler: route.handler, params };
    }
    return null;
  }
}
