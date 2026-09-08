"""OpenRouter Free Model Proxy.

A sidecar HTTP proxy that discovers zero-cost OpenRouter models,
keeps them warm via periodic pings, and routes requests through
them round-robin with automatic fallback on errors.

Usage (module)::

    python -m openrouter_proxy --api-key sk-or-v1-... --port 8080

Usage (programmatic)::

    from openrouter_proxy.proxy import create_app
    app = create_app(api_key="sk-or-v1-...")
"""

__version__ = "0.1.0"