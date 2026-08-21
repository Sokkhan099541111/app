/**
 * Installs a one-time monkey-patch over the global `fetch` so every one of
 * the ~30 existing pages -- which all call raw `fetch("/api/...")` directly,
 * axios is a listed dependency but is not actually used anywhere -- gets
 * JWT auth for free without having to touch each call site individually:
 *
 *   1. Every request to `/api/*` (except the public login endpoint) gets
 *      `Authorization: Bearer <token>` attached automatically, read fresh
 *      from localStorage on each call.
 *   2. Any `/api/*` response that comes back 401 (missing/expired/invalid
 *      token, or the account got deactivated) clears the stored session and
 *      hard-redirects to /login -- a full page reload rather than a
 *      react-router navigate, since this code runs outside of React and
 *      has no access to a router instance. That's fine: a 401 means the
 *      whole in-memory app state is stale anyway.
 *
 * Call installApiFetchInterceptor() exactly once, from main.tsx, before the
 * app renders.
 */
export const AUTH_TOKEN_KEY = "authToken";

let installed = false;

export function installApiFetchInterceptor() {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isApiCall = url.startsWith("/api/");
    const isPublicAuthCall = url.startsWith("/api/auth/login");

    let finalInit = init;
    if (isApiCall && !isPublicAuthCall) {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      if (token) {
        finalInit = {
          ...init,
          headers: {
            ...(init?.headers || {}),
            Authorization: `Bearer ${token}`,
          },
        };
      }
    }

    const response = await originalFetch(input, finalInit);

    if (isApiCall && !isPublicAuthCall && response.status === 401) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }

    return response;
  };
}
