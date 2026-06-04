from __future__ import annotations

from .db import SessionLocal


async def get_db():
    async with SessionLocal() as session:
        yield session
