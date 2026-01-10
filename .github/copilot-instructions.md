## Microsoft 365 naming (reference)
Microsoft 365 Agents Toolkit was formerly called Teams Toolkit. Prefer the new names, but recognize older ones.

| New name | Former name |
|---|---|
| Microsoft 365 Agents Toolkit | Teams Toolkit |
| App Manifest | Teams app manifest |
| Microsoft 365 Agents Playground | Test Tool |
| `teamsapp.yml` | (`m365agents.yml` in newer templates) |
| `atk` CLI (`@microsoft/m365agentstoolkit-cli`) | `teamsapp` CLI |

# Copilot instructions for this repo

## Big picture
- This repo packages a Microsoft 365 Copilot **declarative agent** + **API plugin** that queries Bloxs via **OData**.
- The agent runs in Microsoft 365 Copilot (no app backend required). Auth is handled via an **API key in Plugin Vault**.
- A Cloudflare Worker proxy exists to provide a short key + JWT management for the Bloxs OData API.
- Aside from the Worker, this repo is mostly manifests/specs (the root `package.json` scripts are template-y; there are no tests configured).

## Key files / where to change things
- Agent prompt + starters: [appPackage/declarativeAgent.json](../appPackage/declarativeAgent.json)
- Plugin manifest (functions list, model description): [appPackage/ai-plugin.json](../appPackage/ai-plugin.json)
- OpenAPI spec (paths/entity sets, server URL): [appPackage/bloxs-openapi.yaml](../appPackage/bloxs-openapi.yaml)
- Teams app manifest (icons, domains): [appPackage/manifest.json](../appPackage/manifest.json)
- Cloudflare Worker proxy: [cloudflare-proxy/src/index.js](../cloudflare-proxy/src/index.js)

## Bloxs/OData conventions (project-specific)
- **Tenant-specific labels:** Do not hardcode string-equals filters for Status/State/WorkflowState/CategoryName. First discover valid values via lookup endpoints (e.g. `ServiceTicketStates`) or by sampling recent records ($top=10–20, $select includes the field), then filter using the exact returned values.
- **Performance:** `FinancialMutations` is large; always use restrictive `$filter`, keep `$top` small (<= 100), and prefer `$select`.
- **Endpoint names are case-/tenant-sensitive:** verify entity-set names against `/odatafeed/$metadata/` when changing the OpenAPI spec.
- The proxy has a helper endpoint `/odatafeed/$metadata-summary` for human debugging and field examples.

## Developer workflows
- Provision/publish the agent via Microsoft 365 Agents Toolkit using [teamsapp.yml](../teamsapp.yml) / [teamsapp.local.yml](../teamsapp.local.yml). `deploy` is intentionally empty; packaging/registration happens in `provision`/`publish`.
- Cloudflare proxy:
	- Install: `cd cloudflare-proxy && npm install`
	- Local: `npm run dev`
	- Deploy: `npm run deploy`
	- Secrets are set with `wrangler secret put BLOXS_API_KEY`, `BLOXS_API_SECRET`, `PROXY_API_KEY` (see [cloudflare-proxy/README.md](../cloudflare-proxy/README.md)).

## Safety / secrets
- Never print or commit secrets. Treat `env/.env.*.user` and Worker secrets as sensitive.