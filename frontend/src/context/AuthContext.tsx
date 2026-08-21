import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AUTH_TOKEN_KEY } from "../utils/apiFetch";

export interface AuthRole {
  role_id: number;
  role_name: string;
}

export interface AuthUser {
  user_id: number;
  username: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  roles: AuthRole[];
}

export interface MenuNode {
  menu_id: number;
  parent_menu_id: number | null;
  menu_key: string;
  label: string;
  path: string | null;
  icon: string | null;
  display_order: number;
  is_active: boolean;
  permission_keys: string[];
  children: MenuNode[];
}

interface AuthContextValue {
  user: AuthUser | null;
  menus: MenuNode[];
  loading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** Does the current user hold `permissionKey` (view/create/edit/delete/export) on `menuKey`? */
  can: (menuKey: string, permissionKey: string) => boolean;
  /** Is `path` reachable at all (i.e. present -- with 'view' -- somewhere in the permitted menu tree)? */
  canAccessPath: (path: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function flattenMenus(nodes: MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.children?.length) out.push(...flattenMenus(n.children));
  }
  return out;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [menus, setMenus] = useState<MenuNode[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMenus = useCallback(async () => {
    const res = await fetch("/api/menus/my-menu");
    if (!res.ok) throw new Error("Could not load your menu");
    const result = await res.json();
    setMenus(Array.isArray(result.data) ? result.data : []);
  }, []);

  // Restore session on load/refresh: the JWT survives in localStorage, but
  // the in-memory user/menu state does not.
  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const meRes = await fetch("/api/auth/me");
        if (!meRes.ok) throw new Error("Session expired");
        const meResult = await meRes.json();
        setUser(meResult.user);
        await loadMenus();
      } catch {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        setUser(null);
        setMenus([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadMenus]);

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(result.detail || "Login failed");
      }
      localStorage.setItem(AUTH_TOKEN_KEY, result.access_token);
      setUser(result.user);
      await loadMenus();
    },
    [loadMenus]
  );

  const logout = useCallback(() => {
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setUser(null);
    setMenus([]);
  }, []);

  const flat = useMemo(() => flattenMenus(menus), [menus]);

  const can = useCallback(
    (menuKey: string, permissionKey: string) => {
      const node = flat.find((m) => m.menu_key === menuKey);
      return Boolean(node?.permission_keys?.includes(permissionKey));
    },
    [flat]
  );

  const canAccessPath = useCallback(
    (path: string) => flat.some((m) => m.path === path),
    [flat]
  );

  const value: AuthContextValue = {
    user,
    menus,
    loading,
    isAuthenticated: Boolean(user),
    login,
    logout,
    can,
    canAccessPath,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
