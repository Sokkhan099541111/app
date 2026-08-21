# Fleet Management System

Web application for managing vehicles, drivers, daily operations, rentals,
staff and payroll, with live GPS data from the Wialon platform.

- **Backend** — FastAPI (Python) + MySQL
- **Frontend** — React + Vite + TypeScript + Ant Design

---

## Requirements

- Python 3.9+
- Node.js 18+
- MySQL 5.7+ / MariaDB

## Setup

### 1. Backend

```bash
python3 -m pip install -r app/requirements.txt
cp app/.env.example app/.env      # then edit app/.env with real values
python3 check_db.py               # verify the database connection
python3 run.py                    # starts on http://127.0.0.1:8000
```

### 2. Database

Import the `.sql` files in `app/` via phpMyAdmin or the mysql client.
Run these two **last**, in this order:

1. `app/auth_rbac.sql` — users, roles, permissions, menus
2. `app/users_add_company_id.sql` — links users to a company

Default login after import: **`admin` / `Admin@12345`**.
Change this password immediately under Settings → User Management.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                       # http://localhost:5173
npm run build                     # production build into frontend/dist/
```

`vite.config.ts` proxies `/api` to `http://127.0.0.1:8000` in development.

---

## Security

**Never commit `app/.env`.** It is excluded by `.gitignore`. `app/.env.example`
is the committed template and must only ever contain placeholder values.

Anything committed to git remains in the history even after it is deleted,
so if a credential is committed by mistake, rotate it rather than only
removing the file.

---

## Documentation

| File | Contents |
|---|---|
| `DEPLOYMENT.md` | Deploying to cPanel: what to upload, where, and the `/api` routing options |
| `Fleet_Management_User_Guide_v1.0.docx` | 63-page end-user manual covering every module, for staff training |
| `DASHBOARD_RECOMMENDATION.md` | Design notes for the dashboard |

## Project layout

```
app/                  FastAPI backend
  config/             database + settings
  routes/             API endpoints, one file per module
  services/           auth, RBAC and Wialon integration
  uploads/logos/      company logos (must stay writable)
  *.sql               schema and migrations
frontend/
  pages/              one file per screen
  layouts/            AdminLayout (sidebar, header, permissions)
  src/context/        AuthContext -- login state and permissions
  src/utils/          fetch interceptor, logo helper
run.py                backend entry point
check_db.py           database connection checker
```

## Access control

Menus, pages and action buttons are driven by role permissions
(View / Create / Edit / Delete / Export) configured under
Settings → Role Management. Permissions are enforced both in the UI and
on the server, so hiding a button is a convenience, not the security
boundary.
