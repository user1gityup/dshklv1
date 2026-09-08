"""Warm pool — keep-alive pings, TTL tracking, error cooldowns."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from .discovery import Discovery, FreeModel

logger = logging.getLogger(__name__)


@dataclass
class ModelState:
    model: FreeModel
    last_used: float = field(default_factory=time.monotonic)
    consecutive_errors: int = 0
    is_healthy: bool = True

    @property
    def is_warm(self, ttl: float = 240) -> bool:
        return (time.monotonic() - self.last_used) < ttl


class WarmPool:
    """Warm-pool manager — round-robin, keep-alive, per-model cooldown."""

    KEEP_ALIVE_INTERVAL = 210  # seconds (3.5 min)
    KEEP_ALIVE_TIMEOUT = 30
    MAX_CONSECUTIVE_ERRORS = 3
    ERROR_COOLDOWN = 300

    def __init__(
        self,
        discovery: Discovery,
        api_key: Optional[str] = None,
        keep_alive: bool = False,
    ) -> None:
        self.discovery = discovery
        self.api_key = api_key
        self.keep_alive = keep_alive
        self._states: dict[str, ModelState] = {}
        self._index = 0
        self._lock = asyncio.Lock()
        self._keep_alive_task: Optional[asyncio.Task[None]] = None
        self._stop = asyncio.Event()

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    async def start(self) -> None:
        await self._rebuild()
        # Off unless asked for. Every keep-alive round sends a real chat request
        # to each cold model, and OpenRouter meters free models by request
        # count per day, not by spend: 19 models pinged every 210s is roughly
        # 325 requests an hour against a daily allowance of 50 without credits
        # (1000 with them), so the pool would exhaust the quota it exists to
        # spend before anyone asked it a question. These are hosted models with
        # no cold start to warm anyway.
        if not self.keep_alive:
            logger.info("Keep-alive disabled; models are used on demand")
            return
        self._keep_alive_task = asyncio.create_task(self._keep_alive_loop())

    async def stop(self) -> None:
        self._stop.set()
        if self._keep_alive_task:
            self._keep_alive_task.cancel()
            try:
                await self._keep_alive_task
            except asyncio.CancelledError:
                pass

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------
    async def get_model(self, exclude: Optional[list[str]] = None) -> FreeModel:
        """Return the next healthy model, skipping excluded IDs."""
        exclude_set = set(exclude or [])
        async with self._lock:
            candidates = [
                s
                for mid, s in self._states.items()
                if s.is_healthy and mid not in exclude_set
            ]
            if not candidates:
                raise RuntimeError("No available models in the pool")

            # prefer warm, oldest first
            warm = [s for s in candidates if s.is_warm]
            pool = warm or candidates
            pool.sort(key=lambda s: s.last_used)

            selected = pool[0]
            selected.last_used = time.monotonic()
            return selected.model

    def list_models(self) -> list[dict[str, object]]:
        return [
            {
                "id": s.model.id,
                "context_length": s.model.context_length,
                "healthy": s.is_healthy,
                "warm": s.is_warm,
                "last_used": s.last_used,
            }
            for s in self._states.values()
        ]

    def mark_success(self, model_id: str) -> None:
        if model_id in self._states:
            self._states[model_id].consecutive_errors = 0

    def mark_error(self, model_id: str, retryable: bool = True) -> None:
        state = self._states.get(model_id)
        if state is None:
            return
        state.consecutive_errors += 1
        if not retryable or state.consecutive_errors >= self.MAX_CONSECUTIVE_ERRORS:
            state.is_healthy = False
            logger.error("Model %s marked unhealthy", model_id)
            asyncio.create_task(self._re_enable(model_id, self.ERROR_COOLDOWN))

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    async def _rebuild(self) -> None:
        current = {m.id for m in self.discovery.models}
        async with self._lock:
            for dead in list(self._states):
                if dead not in current:
                    del self._states[dead]
            for m in self.discovery.models:
                if m.id not in self._states:
                    self._states[m.id] = ModelState(model=m)

    async def _keep_alive_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(
                    self._stop.wait(), timeout=self.KEEP_ALIVE_INTERVAL
                )
                return
            except asyncio.TimeoutError:
                pass
            await self._ping_cold()
            await self._rebuild()

    async def _ping_cold(self) -> None:
        threshold = time.monotonic() - 180
        async with self._lock:
            targets = [
                s
                for s in self._states.values()
                if s.is_healthy and s.last_used < threshold
            ]
        if not targets:
            return

        logger.debug("Pinging %d cold model(s)", len(targets))
        sem = asyncio.Semaphore(5)

        async def _one(s: ModelState) -> None:
            async with sem:
                ok = await self._ping(s.model)
                async with self._lock:
                    if ok:
                        s.last_used = time.monotonic()
                        s.consecutive_errors = 0
                    else:
                        s.consecutive_errors += 1

        await asyncio.gather(*(_one(s) for s in targets), return_exceptions=True)

    async def _ping(self, model: FreeModel) -> bool:
        try:
            async with httpx.AsyncClient(timeout=self.KEEP_ALIVE_TIMEOUT) as client:
                headers: dict[str, str] = {}
                if self.api_key:
                    headers["Authorization"] = f"Bearer {self.api_key}"
                resp = await client.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers=headers,
                    json={
                        "model": model.id,
                        "messages": [{"role": "user", "content": "Hi"}],
                        "max_tokens": 1,
                        "temperature": 0,
                    },
                )
                return resp.status_code == 200
        except Exception as exc:
            logger.debug("Keep-alive failed for %s: %s", model.id, exc)
            return False

    async def _re_enable(self, model_id: str, delay: float) -> None:
        await asyncio.sleep(delay)
        async with self._lock:
            if model_id in self._states:
                self._states[model_id].is_healthy = True
                self._states[model_id].consecutive_errors = 0
                logger.info("Re-enabled model: %s", model_id)