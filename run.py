"""
Backend entry point.

Local development:
    python3 run.py
    -> http://127.0.0.1:8000 with auto-reload

Production (DigitalOcean App Platform, Render, Railway, etc.):
    The platform assigns a port through the PORT environment variable and
    expects the app to bind to it on 0.0.0.0. Auto-reload must be off in
    production -- it doubles memory use and restarts the server on any
    file change.
"""
import os

import uvicorn

if __name__ == "__main__":
    # Hosting platforms inject PORT. Default to 8000 for local development.
    port = int(os.getenv("PORT", "8000"))

    # Reload only when explicitly developing. Any platform that sets PORT
    # is treated as production.
    is_production = os.getenv("PORT") is not None or os.getenv("ENV") == "production"

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=port,
        reload=not is_production,
    )
