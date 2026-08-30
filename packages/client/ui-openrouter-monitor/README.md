# OpenRouter Monitor Plugin for DSH

A server-monitor-style sidebar panel showing your OpenRouter API credit balance
and per-model cost breakdown.

## Installation

### 1. Copy the plugin into the DSH checkout

```powershell
$DSH = "<path-to-your-deepseek-harness-checkout>"
Copy-Item -Recurse ".\packages\client\ui-openrouter-monitor" `
  "$DSH\packages\client\ui-openrouter-monitor"
```

### 2. Update the web bundle config

Add this row to `packages/bundle/web-app/cordis.patch.yml`
in the `dsh.client` rows section (after the last existing ui-* entry, around line 292):

```yaml
    - id: ui-openrouter-monitor
      name: '@deepseek-ai/dsh-client-ui-openrouter-monitor'
```

### 3. Update the profile config

Add this to `$env:DSH_HOME\profiles\web\cordis.patch.yml`:

```yaml
- insert:
    - id: ui-openrouter-monitor
      name: '@deepseek-ai/dsh-client-ui-openrouter-monitor'
```

Replace the existing `[]` with the above YAML.

### 4. Reinstall dependencies

```powershell
cd $DSH
pnpm install
```

### 5. Build the plugin

```powershell
cd $DSH
pnpm --filter @deepseek-ai/dsh-client-ui-openrouter-monitor bundle
```

### 6. Restart DSH

The running DSH web session will pick up the new plugin on restart. If `pnpm run dev:web` is running, it may pick up the change via HMR.

### 7. Configure your OpenRouter key

1. Click the credit-card icon at the bottom of the sidebar
2. Paste your OpenRouter API key (starts with `sk-or-v1-`)
3. Click Save

The key is stored in your browser's localStorage (under `dsh:openrouter-monitor:api-key`) and is only used for direct API calls to OpenRouter's `/credits` and `/generation` endpoints.

## Features

- **Balance display**: Green/amber/red color-coded credit balance with a progress bar
- **Per-model cost breakdown**: Bar chart showing cost distribution across models
- **Auto-refresh**: Refreshes every 60 seconds while the panel is open
- **Rail & expanded modes**: Works in both collapsed sidebar and wide modes

## Files

```
packages/client/ui-openrouter-monitor/
├── package.json                       # Package metadata + dsh.client declaration
├── tsconfig.json                      # TypeScript config
├── tsdown.config.ts                   # Build config (client bundle preset)
├── src/
│   ├── index.ts                       # Shallow package re-export
│   ├── invariant.ts                   # Assertion utility
│   └── client/
│       ├── index.ts                   # apply(ctx) plugin entry point
│       ├── locales.ts                 # English dictionary strings
│       ├── openrouter-api.ts          # OpenRouter REST API client
│       ├── OpenRouterMonitor.tsx      # Main React component
│       └── OpenRouterMonitor.module.css # Component styles
└── tests/
    └── plugin.client.spec.ts          # Basic presence test
```