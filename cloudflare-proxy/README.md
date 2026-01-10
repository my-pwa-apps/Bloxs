# Bloxs OData Proxy for Cloudflare Workers

This Cloudflare Worker acts as a proxy between Microsoft 365 Copilot and the Bloxs OData API. It handles JWT token management automatically, allowing you to use a short API key (under 128 characters) with Copilot.

## How It Works

1. Copilot sends requests to your Worker with a short `PROXY_API_KEY`
2. The Worker authenticates with Bloxs using your API key/secret
3. It caches the JWT token and refreshes it automatically when needed
4. Requests are forwarded to the Bloxs OData API with the valid JWT

## Setup

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

### 3. Install dependencies

```bash
cd cloudflare-proxy
npm install
```

### 4. Set your secrets

```bash
# Your Bloxs API key
wrangler secret put BLOXS_API_KEY
# Enter: NjY1MjhlZjBkZTUzNDM3Y2FiZTgzMDUxYmJhYzExNDg=

# Your Bloxs API secret
wrangler secret put BLOXS_API_SECRET
# Enter: c3RhZHNnZXppY2h0OmNmMjA2ODI2NWM1NzQ3OGViZWE5ZWMzNmY3MDM3Nzk1OjE2MTAzNzIxODQ=

# Create a short API key for Copilot (any string under 128 chars)
wrangler secret put PROXY_API_KEY
# Enter something like: bloxs-copilot-2024-xyz123
```

### 5. Deploy

```bash
npm run deploy
```

You'll get a URL like: `https://bloxs-proxy.<your-account>.workers.dev`

### 6. Test it

```bash
curl -H "Authorization: Bearer bloxs-copilot-2024-xyz123" \
  "https://bloxs-proxy.<your-account>.workers.dev/odatafeed/Units?$top=2"
```

## Update Copilot Configuration

After deploying, update your OpenAPI spec to use the Worker URL:

```yaml
servers:
  - url: https://bloxs-proxy.<your-account>.workers.dev
```

And register `bloxs-copilot-2024-xyz123` (your short PROXY_API_KEY) in the Teams Developer Portal.

## Local Development

```bash
npm run dev
```

This starts a local server at `http://localhost:8787` for testing.

## Costs

Cloudflare Workers free tier includes:
- 100,000 requests/day
- 10ms CPU time per request

This is more than enough for a Copilot agent.
