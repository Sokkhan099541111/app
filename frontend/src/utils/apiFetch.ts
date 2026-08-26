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
 *   3. If VITE_API_BASE_URL is set, "/api/..." is rewritten to point at
 *      that host (see below).
 *
 * Call installApiFetchInterceptor() exactly once, from main.tsx, before the
 * app renders.
 */
export const AUTH_TOKEN_KEY = "authToken";

/**
 * Where the API lives.
 *
 * Empty (the default) means "same domain as this page", so `/api/employees`
 * is requested from whatever host is serving the frontend. That is correct
 * for BOTH of these setups:
 *
 *   - local development, where vite.config.ts proxies /api to port 8000
 *   - frontend and backend deployed as components of the SAME app or
 *     behind the same nginx, where /api is routed to the backend
 *
 * Only set VITE_API_BASE_URL when the API is on a DIFFERENT domain from
 * the frontend -- for example the frontend on cPanel and the API on
 * DigitalOcean. Set it in frontend/.env.production as a full origin with
 * no trailing slash:
 *
 *     VITE_API_BASE_URL=https://urchin-app-3tpdf.ondigitalocean.app
 *
 * Vite substitutes this at BUILD time, not run time, so you must rebuild
 * (npm run build) after changing it. Cross-domain also requires the API to
 * allow this origin via its CORS_ORIGINS setting.
 */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/** Rewrites "/api/x" to "https://api-host/api/x" when a base URL is set. */
function resolveApiUrl(url: string): string {
  if (!API_BASE_URL) return url;
  if (url.startsWith("/api/") || url.startsWith("/uploads/")) {
    return API_BASE_URL + url;
  }
  return url;
}

let installed = false;

export function installApiFetchInterceptor() {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isApiCall = url.startsWith("/api/");
    const isPublicAuthCall = url.startsWith("/api/auth/login");

    // Point the request at the configured API host, if any.
    let finalInput: RequestInfo | URL = input;
    const resolved = resolveApiUrl(url);
    if (resolved !== url) {
      finalInput =
        typeof input === "string" || input instanceof URL
          ? resolved
          : new Request(resolved, input); // preserves method, body, headers
    }

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

    const response = await originalFetch(finalInput, finalInit);

    if (isApiCall && !isPublicAuthCall && response.status === 401) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }

    return response;
  };
}
