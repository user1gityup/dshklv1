"""OpenRouter free-model discovery — fetch /models, filter zero-cost seats."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"


@dataclass(frozen=True)
class FreeModel:
    """A free-tier OpenRouter model."""

    id: str
    context_length: int = 4096
    input_modalities: tuple[str, ...] = ("text",)
    output_modalities: tuple[str, ...] = ("text",)

    @property
    def is_chat_model(self) -> bool:
        """Whether this model answers text with text, and nothing else.

        Read from the model's declared modalities rather than guessed from its
        name. Price alone is not enough of a filter: OpenRouter lists
        zero-priced media models beside the chat ones, and a request routed to
        one comes back HTTP 200 carrying a refusal instead of an answer —
        measured against google/lyria-3-pro-preview, which returned
        `finish_reason: content_filter` for a plain question.
        """
        return "text" in self.input_modalities and tuple(self.output_modalities) == ("text",)


class Discovery:
    """Continuously discovers free OpenRouter models."""

    REFRESH_INTERVAL = 300  # seconds

    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = api_key
        self._models: list[FreeModel] = []
        self._lock = asyncio.Lock()
        self._task: Optional[asyncio.Task[None]] = None

    @property
    def models(self) -> list[FreeModel]:
        return list(self._models)

    async def start(self) -> None:
        await self._refresh_once()
        self._task = asyncio.create_task(self._refresh_loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _refresh_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self.REFRESH_INTERVAL)
                await self._refresh_once()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("Discovery refresh failed: %s", exc)

    async def _refresh_once(self) -> int:
        headers: dict[str, str] = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                OPENROUTER_MODELS_URL,
                headers=headers,
                params={"limit": 500},
            )
            resp.raise_for_status()
            data = resp.json()

        free: list[FreeModel] = []
        skipped = 0
        for m in data.get("data", []):
            pricing = m.get("pricing", {})
            pp = pricing.get("prompt", 1)
            cp = pricing.get("completion", 1)
            try:
                if float(pp) != 0.0 or float(cp) != 0.0:
                    continue
            except (ValueError, TypeError):
                continue
            arch = m.get("architecture") or {}
            candidate = FreeModel(
                id=m["id"],
                context_length=m.get("context_length", 4096),
                input_modalities=tuple(arch.get("input_modalities") or ("text",)),
                output_modalities=tuple(arch.get("output_modalities") or ("text",)),
            )
            # A model that emits audio or images is free and useless here: the
            # pool exists to answer chat requests, and routing one to a media
            # model spends the request and returns a refusal.
            if not candidate.is_chat_model:
                skipped += 1
                continue
            free.append(candidate)

        free.sort(key=lambda x: -x.context_length)

        async with self._lock:
            old = {m.id for m in self._models}
            new = {m.id for m in free}
            if old != new:
                logger.info(
                    "Free models updated: %d chat model(s), %d non-chat skipped",
                    len(free),
                    skipped,
                )
                for m in free[:5]:
                    logger.debug("  %s (ctx=%d)", m.id, m.context_length)
            self._models = free

        return len(free)