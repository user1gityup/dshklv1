"""FastAPI proxy — OpenAI-compatible endpoint backed by free-model pool."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .discovery import Discovery
from .pool import WarmPool
from .scheduler import Scheduler

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# shared app state (module-level so lifespan can reach it)
# ---------------------------------------------------------------------------
_discovery: Discovery | None = None
_pool: WarmPool | None = None
_scheduler: Scheduler | None = None


# ---------------------------------------------------------------------------
# factory
# ---------------------------------------------------------------------------
def create_app(api_key: str | None = None, dsh_path: str | None = None) -> FastAPI:  # noqa: ARG001
    """Build a FastAPI app wired to the free-model pool.

    Falls back to ``OPENROUTER_API_KEY`` env var when *api_key* is not given.
    Keep-alive pinging is off unless ``OPENROUTER_PROXY_KEEP_ALIVE`` is set to
    a truthy value; see :meth:`WarmPool.start` for why.
    *dsh_path* is reserved for future DSH config auto-patching; ignored for now.
    """
    effective_key = api_key or os.environ.get("OPENROUTER_API_KEY")
    keep_alive = os.environ.get("OPENROUTER_PROXY_KEEP_ALIVE", "").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if not effective_key:
        raise RuntimeError(
            "OPENROUTER_API_KEY must be set in env or passed to create_app()"
        )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        global _discovery, _pool, _scheduler

        _discovery = Discovery(api_key=effective_key)
        await _discovery.start()
        await asyncio.sleep(2)  # let first discovery settle

        _pool = WarmPool(_discovery, api_key=effective_key, keep_alive=keep_alive)
        await _pool.start()

        _scheduler = Scheduler(_pool, api_key=effective_key)
        logger.info("OpenRouter free-model proxy ready")

        yield

        if _pool:
            await _pool.stop()
        if _discovery:
            await _discovery.stop()

    app = FastAPI(title="OpenRouter Free Model Proxy", version="0.1.0", lifespan=lifespan)

    # ------------------------------------------------------------------
    # POST /v1/chat/completions
    # ------------------------------------------------------------------
    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request) -> Any:
        if _scheduler is None:
            raise HTTPException(status_code=503, detail="Proxy not ready yet")

        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")

        if "messages" not in body:
            raise HTTPException(status_code=400, detail="Missing 'messages' field")

        want_stream = body.get("stream", False)

        try:
            if want_stream:
                return StreamingResponse(
                    _stream_body(body),
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no",
                    },
                )
            else:
                resp = await _scheduler.execute(body, stream=False)
                return JSONResponse(content=resp.json())

        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

    # ------------------------------------------------------------------
    # GET /v1/models
    # ------------------------------------------------------------------
    @app.get("/v1/models")
    async def list_models() -> JSONResponse:
        if _pool is None:
            return JSONResponse(content={"object": "list", "data": []})
        models = _pool.list_models()
        return JSONResponse(
            content={
                "object": "list",
                "data": [
                    {
                        "id": m["id"],
                        "object": "model",
                        "created": 0,
                        "owned_by": "openrouter",
                    }
                    for m in models
                ],
            }
        )

    # ------------------------------------------------------------------
    # GET /health
    # ------------------------------------------------------------------
    @app.get("/health")
    async def health() -> dict[str, object]:
        if _pool is None:
            return {"status": "starting"}
        states = _pool._states  # type: ignore[union-attr]
        return {
            "status": "healthy",
            "models_total": len(states),
            "models_warm": sum(1 for s in states.values() if s.is_warm),
            "models_healthy": sum(1 for s in states.values() if s.is_healthy),
        }

    return app


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
async def _stream_body(body: dict[str, object]) -> AsyncIterator[str]:
    assert _scheduler is not None
    try:
        async for chunk in _scheduler.execute_stream(body):
            yield f"data: {json.dumps(chunk) if isinstance(chunk, dict) else chunk}\n\n"
    except Exception as exc:
        logger.exception("Stream error")
        yield f'data: {json.dumps({"error": str(exc)})}\n\n'
    yield "data: [DONE]\n\n"