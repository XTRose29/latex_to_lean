from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import Base, engine
from .dev_settings import router as dev_settings_router  # DEV-ONLY — remove for prod
from .jobs import router as jobs_router
from .projects import router as projects_router

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create all tables on startup (fine for local dev; use Alembic for prod).
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


app = FastAPI(
    title="pdf_to_lean API",
    description="Benchmark builder for mathematical formalization.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects_router)
app.include_router(jobs_router)
app.include_router(dev_settings_router)  # DEV-ONLY — remove for prod


@app.get("/health")
async def health():
    return {"status": "ok"}
