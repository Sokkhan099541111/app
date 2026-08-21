import os
from dotenv import load_dotenv
from sqlalchemy.engine import URL

load_dotenv()

# --- MySQL / app_hosting database ---
# NOTE: phpMyAdmin's web UI runs on localhost:8080, but that's just the UI --
# the actual MySQL server is almost always on a different port (3306 by
# default). If DATABASE_URL below fails to connect, check what port MySQL
# itself listens on (e.g. `SHOW VARIABLES LIKE 'port';` in phpMyAdmin's SQL
# tab, or your XAMPP/Docker config) and update DB_PORT/DB_HOST in .env.
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "3306")
DB_USER = os.getenv("DB_USER", "phpmyadmin")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "app_hosting")

# Used by routes that need a Wialon company_id but the frontend doesn't yet
# send one (no company switcher/auth in the UI yet). Falls back to the
# single seeded row (company_id=1) in company_wialon_credentials.
DEFAULT_COMPANY_ID = int(os.getenv("DEFAULT_COMPANY_ID", "1"))

# --- Auth (JWT bearer tokens, see app/services/auth_service.py) ---
# IMPORTANT: set JWT_SECRET_KEY in app/.env for any real deployment -- this
# fallback is fine for local development only. Any token signed with a key
# that later changes is immediately invalidated (all users get logged out),
# so keep this stable and secret in production.
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "dev-only-insecure-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "480"))  # 8 hours

# Built with URL.create() rather than an f-string so special characters in
# the username/password (e.g. "@", ":", "/") get URL-encoded correctly.
# A plain f-string breaks as soon as a password contains "@" -- it gets
# read as the user@host separator and mangles the hostname.
DATABASE_URL = URL.create(
    drivername="mysql+pymysql",
    username=DB_USER,
    password=DB_PASSWORD,
    host=DB_HOST,
    port=int(DB_PORT),
    database=DB_NAME,
)
