import { Layout, Menu, Avatar, Dropdown, Space, Flex } from "antd";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  DashboardOutlined,
  CarOutlined,
  UserOutlined,
  FileTextOutlined,
  SettingOutlined,
  LogoutOutlined,
  DownOutlined,
  DollarOutlined,
  TeamOutlined,
  ApartmentOutlined,
  IdcardOutlined,
  ToolOutlined,
  CalendarOutlined,
  ShopOutlined,
  DollarCircleOutlined,
  TableOutlined,
  TagOutlined,
  CalculatorOutlined,
  ContactsOutlined,
  WalletOutlined,
  FundOutlined,
  KeyOutlined,
  SafetyCertificateOutlined,
  MenuOutlined,
  AppstoreOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth, type MenuNode } from "../src/context/AuthContext";

const { Header, Sider, Content } = Layout;

const APP_NAME = "Fleet Management";

// Resolves the icon-name-as-string stored in the `menus` table (see
// app/auth_rbac.sql) to the actual antd icon component. Menu content is now
// driven entirely by the backend (Menu Management page -> role_menu_permissions
// -> GET /menus/my-menu) rather than a hardcoded NAV array, so new menus/
// submenus created there show up automatically without a frontend deploy --
// as long as their icon name is one of the ones registered here. Falls back
// to a generic icon for anything unrecognized rather than crashing.
const ICON_MAP: Record<string, ReactNode> = {
  DashboardOutlined: <DashboardOutlined />,
  CarOutlined: <CarOutlined />,
  UserOutlined: <UserOutlined />,
  FileTextOutlined: <FileTextOutlined />,
  SettingOutlined: <SettingOutlined />,
  DollarOutlined: <DollarOutlined />,
  TeamOutlined: <TeamOutlined />,
  ApartmentOutlined: <ApartmentOutlined />,
  IdcardOutlined: <IdcardOutlined />,
  ToolOutlined: <ToolOutlined />,
  CalendarOutlined: <CalendarOutlined />,
  ShopOutlined: <ShopOutlined />,
  DollarCircleOutlined: <DollarCircleOutlined />,
  TableOutlined: <TableOutlined />,
  TagOutlined: <TagOutlined />,
  CalculatorOutlined: <CalculatorOutlined />,
  ContactsOutlined: <ContactsOutlined />,
  WalletOutlined: <WalletOutlined />,
  FundOutlined: <FundOutlined />,
  KeyOutlined: <KeyOutlined />,
  SafetyCertificateOutlined: <SafetyCertificateOutlined />,
  MenuOutlined: <MenuOutlined />,
};

function iconFor(name: string | null | undefined): ReactNode {
  return (name && ICON_MAP[name]) || <AppstoreOutlined />;
}

function toMenuItems(nodes: MenuNode[]) {
  return nodes.map((entry) =>
    entry.children.length > 0
      ? {
          key: entry.menu_key,
          icon: iconFor(entry.icon),
          label: entry.label,
          children: entry.children.map((child) => ({
            key: child.menu_key,
            icon: iconFor(child.icon),
            label: <Link to={child.path || "#"}>{child.label}</Link>,
          })),
        }
      : { key: entry.menu_key, icon: iconFor(entry.icon), label: <Link to={entry.path || "#"}>{entry.label}</Link> }
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, menus, logout } = useAuth();

  const MENU_ITEMS = useMemo(() => toMenuItems(menus), [menus]);

  // Derived from the logged-in user's permitted menu tree: path -> header/
  // tab title, and path -> which menu key(s) should be shown as selected/
  // open. This is what keeps "page title matches selected menu" true even
  // though the menu itself is now backend-driven instead of a static array.
  const { pageTitles, pathToKeys } = useMemo(() => {
    const titles: Record<string, string> = {};
    const keys: Record<string, { selectedKey: string; parentKey?: string }> = {};
    for (const entry of menus) {
      if (entry.children.length > 0) {
        for (const child of entry.children) {
          if (!child.path) continue;
          titles[child.path] = child.label;
          keys[child.path] = { selectedKey: child.menu_key, parentKey: entry.menu_key };
        }
      } else if (entry.path) {
        titles[entry.path] = entry.label;
        keys[entry.path] = { selectedKey: entry.menu_key };
      }
    }
    return { pageTitles: titles, pathToKeys: keys };
  }, [menus]);

  const nav = pathToKeys[location.pathname];
  const pageTitle = nav ? pageTitles[location.pathname] : APP_NAME;
  const selectedKeys = nav ? [nav.selectedKey] : [];
  const [openKeys, setOpenKeys] = useState<string[]>(nav?.parentKey ? [nav.parentKey] : []);

  useEffect(() => {
    document.title = pageTitle === APP_NAME ? APP_NAME : `${pageTitle} - ${APP_NAME}`;
  }, [pageTitle]);

  // Auto-expand whichever submenu contains the current page -- via a
  // sidebar click, browser back/forward, or a deep link -- without
  // collapsing any submenu the user already opened manually.
  useEffect(() => {
    const parentKey = pathToKeys[location.pathname]?.parentKey;
    if (parentKey) {
      setOpenKeys((prev) => (prev.includes(parentKey) ? prev : [...prev, parentKey]));
    }
  }, [location.pathname, pathToKeys]);

  const userMenuItems = [
    {
      key: "logout",
      label: "Logout",
      icon: <LogoutOutlined />,
      danger: true,
      onClick: () => {
        logout();
        navigate("/login", { replace: true });
      },
    },
  ];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      {/* Sidebar -- collapses to icons-only automatically on narrow
          screens (breakpoint="lg"), and can still be toggled manually. */}
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} breakpoint="lg" collapsedWidth={0}>
        <div style={{ color: "#fff", padding: 16, textAlign: "center", fontSize: 18, fontWeight: "bold" }}>
          GPS SYSTEM
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selectedKeys}
          openKeys={openKeys}
          onOpenChange={(keys) => setOpenKeys(keys as string[])}
          items={MENU_ITEMS}
        />
      </Sider>

      {/* Main Layout - Contains Header and Content */}
      <Layout>
        <Header style={{ background: "#fff", padding: "0 20px" }}>
          <Flex justify="space-between" align="center" style={{ height: "100%" }}>
            <span style={{ fontSize: 20, fontWeight: "bold" }}>{pageTitle}</span>

            {/* User Profile Controls */}
            <Dropdown menu={{ items: userMenuItems }}>
              <Space style={{ cursor: "pointer" }}>
                <span>Welcome, <strong>{user?.full_name || user?.username || "Guest"}</strong></span>
                <Avatar icon={<UserOutlined />} />
                <DownOutlined style={{ fontSize: 12 }} />
              </Space>
            </Dropdown>
          </Flex>
        </Header>

        <Content style={{ margin: 16, padding: 24, background: "#fff", borderRadius: 8 }}>
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
