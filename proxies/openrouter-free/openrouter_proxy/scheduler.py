"""Request scheduler — round-robin routing with automatic fallback."""

from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator, Optional

import httpx

from .pool import WarmPool

logger = logging.getLogger(__name__)

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"


class RetryableError(Exception):
    """Transient — try the next model."""


class FatalError(Exception):
    """Permanent — skip this model entirely."""


class Scheduler:
    """Routes requests across warm free models with retry + fallback."""

    MAX_RETRIES = 3

    def __init__(self, pool: WarmPool, api_key: Optional[str] = None) -> None:
        self.pool = pool
        self.api_key = api_key

    async def execute(
        self,
        body: dict[str, object],
        stream: bool = False,
    ) -> httpx.Response:
        """Execute a chat-completion request, retrying on transient errors."""
        tried: list[str] = []
        last: Optional[Exception] = None

        for attempt in range(self.MAX_RETRIES):
            model = await self.pool.get_model(exclude=tried)
            tried.append(model.id)

            req = {**body, "model": model.id}

            try:
                resp = await self._send(req, stream, model.id)
                self.pool.mark_success(model.id)
                return resp

            except RetryableError as exc:
                logger.warning("Retryable error on %s: %s", model.id, exc)
                self.pool.mark_error(model.id, retryable=True)
                last = exc
                await asyncio.sleep(1.0 * (2**attempt))

            except FatalError as exc:
                logger.error("Fatal error on %s: %s", model.id, exc)
                self.pool.mark_error(model.id, retryable=False)
                last = exc
                # don't sleep — immediately try next

        raise RuntimeError(
            f"Exhausted {self.MAX_RETRIES} retries; last error: {last}"
        )

    async def execute_stream(
        self,
        body: dict[str, object],
    ) -> AsyncIterator[str]:
        """Execute and yield SSE payloads, retrying while nothing has shipped.

        The retry loop lives here rather than in :meth:`execute` because a
        streamed response is only readable while its client is open. Handing
        the response object back would close the connection before the first
        chunk was read. A model is only swapped out before any payload has
        been yielded: retrying mid-answer would emit the same reply twice.
        """
        tried: list[str] = []
        last: Optional[Exception] = None

        for attempt in range(self.MAX_RETRIES):
            model = await self.pool.get_model(exclude=tried)
            tried.append(model.id)
            req = {**body, "model": model.id, "stream": True}

            emitted = False
            try:
                async for payload in self._stream_once(req, model.id):
                    emitted = True
                    yield payload
                self.pool.mark_success(model.id)
                return

            except RetryableError as exc:
                logger.warning("Retryable stream error on %s: %s", model.id, exc)
                self.pool.mark_error(model.id, retryable=True)
                last = exc
                if emitted:
                    raise RuntimeError(f"Stream broke mid-answer on {model.id}: {exc}") from exc
                await asyncio.sleep(1.0 * (2**attempt))

            except FatalError as exc:
                logger.error("Fatal stream error on %s: %s", model.id, exc)
                self.pool.mark_error(model.id, retryable=False)
                last = exc
                if emitted:
                    raise RuntimeError(f"Stream broke mid-answer on {model.id}: {exc}") from exc

        raise RuntimeError(
            f"Exhausted {self.MAX_RETRIES} retries; last error: {last}"
        )

    async def _stream_once(
        self,
        body: dict[str, object],
        model_id: str,
    ) -> AsyncIterator[str]:
        """Stream one upstream call, yielding each `data:` payload verbatim."""
        headers = self._headers()
        timeout = httpx.Timeout(connect=10, read=90, write=10, pool=5)
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                async with client.stream(
                    "POST",
                    OPENROUTER_CHAT_URL,
                    headers=headers,
                    json=body,
                ) as resp:
                    if resp.status_code == 429:
                        raise RetryableError(f"Rate-limited ({model_id})")
                    if resp.status_code >= 500:
                        raise RetryableError(
                            f"Server error {resp.status_code} ({model_id})"
                        )
                    if resp.status_code >= 400:
                        detail = (await resp.aread()).decode("utf-8", "replace")
                        raise FatalError(
                            f"Client error {resp.status_code} ({model_id}): {detail[:200]}"
                        )

                    async for line in resp.aiter_lines():
                        stripped = line.strip()
                        if not stripped.startswith("data:"):
                            continue
                        payload = stripped[len("data:"):].strip()
                        if payload == "[DONE]":
                            return
                        yield payload

            except httpx.TimeoutException as exc:
                raise RetryableError(f"Timeout: {exc}") from exc
            except httpx.ConnectError as exc:
                raise RetryableError(f"Connection failed: {exc}") from exc

    def _headers(self) -> dict[str, str]:
        """Headers every upstream call carries."""
        headers: dict[str, str] = {
            "Content-Type": "application/json",
            "HTTP-Referer": "https://deepseek-harness.local",
            "X-Title": "DSH Free Model Proxy",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    # ------------------------------------------------------------------
    async def _send(
        self,
        body: dict[str, object],
        stream: bool,
        model_id: str,
    ) -> httpx.Response:
        headers = self._headers()

        body_with_stream = {**body, "stream": stream}

        async with httpx.AsyncClient(timeout=120) as client:
            try:
                resp = await client.post(
                    OPENROUTER_CHAT_URL,
                    headers=headers,
                    json=body_with_stream,
                    timeout=httpx.Timeout(connect=10, read=60, write=10, pool=5),
                )
            except httpx.TimeoutException as exc:
                raise RetryableError(f"Timeout: {exc}") from exc
            except httpx.ConnectError as exc:
                raise RetryableError(f"Connection failed: {exc}") from exc

            if resp.status_code == 429:
                raise RetryableError(f"Rate-limited ({model_id})")
            if resp.status_code >= 500:
                raise RetryableError(f"Server error {resp.status_code} ({model_id})")
            if resp.status_code >= 400:
                raise FatalError(
                    f"Client error {resp.status_code} ({model_id}): {resp.text[:200]}"
                )

            return resp