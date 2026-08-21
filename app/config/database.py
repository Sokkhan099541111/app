from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from app.config.settings import DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,  # ping the connection before using it, so MySQL
                         # dropping idle connections doesn't surface as a
                         # hard-to-debug error mid-request
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """
    FastAPI dependency that yields a DB session for the duration of a
    request and closes it afterwards.

    Usage in a route:
        from fastapi import Depends
        from app.config.database import get_db

        @router.get("/something")
        def handler(db: Session = Depends(get_db)):
            ...
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
