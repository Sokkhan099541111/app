import os

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.routes import (
    snkrp_route,
    vehicle_operation_logs_route,
    employee_route,
    department_route,
    position_route,
    salary_history_route,
    food_policy_route,
    payroll_period_route,
    attendance_route,
    payroll_entry_route,
    payroll_report_route,
    vehicle_rental_route,
    formula_route,
    daily_kpi_route,
    vendor_route,
    vehicle_expense_route,
    vehicle_financial_report_route,
    company_wialon_credential_route,
    dashboard_route,
    auth,
    users,
    role_route,
    menu_route,
)
from app.config.database import get_db
from app.services.auth_service import get_current_user, require_action_permission

app = FastAPI()

# Which browser origins may call this API.
#
# Local development is always allowed. For a deployed frontend, set
# CORS_ORIGINS in the environment to a comma-separated list of full
# origins, e.g.
#     CORS_ORIGINS=https://fleet.example.com,https://www.example.com
#
# Note: if the frontend and API are served from the SAME domain (for
# example DigitalOcean routing /api to this service), the browser makes
# same-origin requests and CORS never comes into play -- this setting is
# only needed when they live on different domains.
_default_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
_env_origins = [
    o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_default_origins + _env_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth is public (login must be reachable without a token). /auth/logout and
# /auth/me each declare their own Depends(get_current_user) internally.
app.include_router(auth.router, prefix="/api")

# users/roles/menus management routers -- each individual endpoint already
# gates on Depends(require_permission(...)) (which itself requires login),
# so no extra router-level guard is needed here.
app.include_router(users.router, prefix="/api")
app.include_router(role_route.router, prefix="/api")
app.include_router(menu_route.router, prefix="/api")

# All pre-existing routers below are guarded by require_action_permission:
# every request still requires a valid login, and mutating requests (POST/
# PUT/PATCH/DELETE) additionally require the create/edit/delete permission
# on that router's menu(s) -- see app/services/auth_service.py for why GET
# stays login-only (cross-module dropdown reads). Routers that serve more
# than one menu list all of them; holding the permission on any one passes.
def _guard(*menu_keys: str):
    return [Depends(require_action_permission(*menu_keys))]


app.include_router(snkrp_route.router, prefix="/api", dependencies=_guard("daily-activities"))
app.include_router(vehicle_operation_logs_route.router, prefix="/api", dependencies=_guard("operation-logs"))
app.include_router(employee_route.router, prefix="/api", dependencies=_guard("employees"))
app.include_router(department_route.router, prefix="/api", dependencies=_guard("departments"))
app.include_router(position_route.router, prefix="/api", dependencies=_guard("positions"))
app.include_router(salary_history_route.router, prefix="/api", dependencies=_guard("payroll-salary-history"))
app.include_router(food_policy_route.router, prefix="/api", dependencies=_guard("payroll-food-policy"))
app.include_router(payroll_period_route.router, prefix="/api", dependencies=_guard("payroll-periods"))
app.include_router(attendance_route.router, prefix="/api", dependencies=_guard("payroll-attendance", "payroll-attendance-report"))
app.include_router(payroll_entry_route.router, prefix="/api", dependencies=_guard("payroll-entries"))
app.include_router(payroll_report_route.router, prefix="/api", dependencies=_guard("payroll-report", "payroll-worksheet"))
app.include_router(vehicle_rental_route.router, prefix="/api", dependencies=_guard("rental-vehicles", "rental-attendance", "rental-report"))
app.include_router(formula_route.router, prefix="/api", dependencies=_guard("settings-formula"))
app.include_router(daily_kpi_route.router, prefix="/api", dependencies=_guard("daily-kpi"))
app.include_router(vendor_route.router, prefix="/api", dependencies=_guard("settings-vendors"))
app.include_router(vehicle_expense_route.router, prefix="/api", dependencies=_guard("vehicle-expenses"))
app.include_router(vehicle_financial_report_route.router, prefix="/api", dependencies=_guard("vehicle-financial-report"))
app.include_router(company_wialon_credential_route.router, prefix="/api", dependencies=_guard("settings-wialon-credentials"))
app.include_router(dashboard_route.router, prefix="/api", dependencies=_guard("dashboard"))

# Serves uploaded files (e.g. company logos saved by
# company_wialon_credential_route.py's upload-logo endpoint) at /uploads/...
UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")


@app.get("/")
def read_root():
    return {"message": "It works"}


@app.get("/api/db/ping")
def db_ping(db: Session = Depends(get_db)):
    """Quick check that the app_hosting MySQL connection works."""
    try:
        db.execute(text("SELECT 1"))
        return {"status": "success", "message": "Connected to app_hosting"}
    except Exception as e:
        return {"status": "error", "message": str(e)}