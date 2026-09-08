# OpenRouter Free Model Proxy

A small OpenAI-compatible proxy that pools OpenRouter's zero-priced models and
routes each request to one of them. It exists so the council's `openrouter-free`
seat has something to talk to.

The council seat is a bare chat completion pointed at
`http://127.0.0.1:8080/v1/chat/completions` with the model `proxy-auto`. The
proxy rewrites that placeholder to whichever free model it currently prefers, so
the seat never has to know which free models exist this week — that list changes
often, and a pinned free model is a seat that fails the day it is retired.

## What it does

- Fetches OpenRouter's `/models` catalogue and keeps only models whose prompt
  *and* completion price are both zero. Models that emit audio or images are
  dropped: free, but useless as a council seat.
- Sorts the survivors by context length and pools them.
- Round-robins across the pool, falling through to the next model when one
  refuses capacity. Free-tier capacity belongs to the provider, not to you, so
  a single free model is a coin flip and a pool is not.

## Requirements

- Python 3.10 or newer
- An OpenRouter account and API key (free models still need an authenticated
  key; they are billed at zero, not anonymous)

## Install and run

```bash
cd proxies/openrouter-free
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt

export OPENROUTER_API_KEY=sk-or-v1-...
python -m openrouter_proxy
```

It binds `127.0.0.1:8080` by default. `--host` and `--port` change that;
`--api-key` overrides the environment.

Check it:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/v1/models
```

`/health` answers with the pool's size and condition, for example
`{"status":"healthy","models_total":17,"models_warm":0,"models_healthy":17}`.
`{"status":"starting"}` means discovery has not finished; a `models_total` of 0
after that means the catalogue came back with nothing free, or the key was
rejected.

### `--keep-alive`

Off by default, and leave it off unless you know why you want it. Each keep-alive
ping is a real chat request, and OpenRouter meters free models per request per
day — pinging spends the exact allowance the pool exists to spend.

## Wiring the seat

The council ships the `openrouter-free` seat disabled, because a seat that fails
on every run of a fresh install is worse than one you turn on. Enable it in
`$DSH_HOME/settings.yaml`:

```yaml
council:
  seats:
    openrouter-free:
      enabled: true
```

To also offer the pool as a *model* in DSH's own picker — separate from the
council seat — add a provider:

```yaml
llm-pi-ai:
  providers:
    openrouter-free:
      displayName: OpenRouter Free
      api: openai-completions
      baseURL: http://127.0.0.1:8080/v1
      apiKeyEnv: OPENROUTER_API_KEY
      models:
        - id: proxy-auto
          name: Free (auto-routed free models)
          contextWindow: 65536
```

The seat and the provider are independent; you can have either without the other.

## Running it with DSH

[`scripts/`](../../scripts/) has a launcher that starts this proxy alongside DSH
and stops it again on exit, so the seat is not left pointing at nothing. Set
`ORFREE_DIR` to this directory in `dsh-env.cmd` and it is started automatically.

## Limits

- **The pool is only as good as the free tier.** A free model can be busy,
  rate-limited, or withdrawn between one request and the next. The seat carries
  a 420s timeout for exactly this reason.
- **Free models are small.** The default `contextWindow` above is 65,536, which
  is a claim about the pool, not a guarantee about any one member.
- **`--dsh-path` writes a config override** in an older shape than the provider
  block documented above. Prefer editing `settings.yaml` by hand.
