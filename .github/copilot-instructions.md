## Microsoft 365 Naming Reference
Microsoft 365 Agents Toolkit was formerly called Teams Toolkit. Prefer the new names, but recognize older ones.

| New name | Former name |
|---|---|
| Microsoft 365 Agents Toolkit | Teams Toolkit |
| App Manifest | Teams app manifest |
| Microsoft 365 Agents Playground | Test Tool |
| `teamsapp.yml` | (`m365agents.yml` in newer templates) |
| `atk` CLI (`@microsoft/m365agentstoolkit-cli`) | `teamsapp` CLI |

# Copilot Instructions for this Repo

## 🏗️ Architecture & Boundaries
This project implements a **Declarative Agent** for Microsoft 365 Copilot.
- **Agent Logic**: Defined entirely in `appPackage/declarativeAgent.json` (instructions) and `ai-plugin.json` (capabilities).
- **Backend**: There is **NO** custom bot service or "Agent SDK" backend. The agent runs on Microsoft's infrastructure.
- **Proxy**: A Cloudflare Worker (`cloudflare-proxy/`) queries the Bloxs OData API. It handles authentication (short API key ↔ JWT) and safety guardrails.
- **State**: The agent is stateless. The proxy caches JWT tokens but stores no conversation state.

### Note on "Microsoft Agents SDK"
- This project does **NOT** use the [Microsoft Agents SDK](https://github.com/MicrosoftDocs/m365copilot-docs/blob/main/docs/m365-agents-sdk.md) (used for building Custom Engine agents).
- It is a **Declarative Agent** which uses the M365 Copilot orchestrator.
- **Do not** suggest adding `teams-ai` or `botbuilder` packages unless the user explicitly wants to re-platform to a custom engine architecture.

## 🔑 Key Files
- **System Prompt**: `appPackage/declarativeAgent.json` (`instructions` field).
- **Tool Definitions**: `appPackage/ai-plugin.json` (maps OData endpoints to Copilot functions).
- **API Spec**: `appPackage/bloxs-openapi.yaml` (Defines the interface for the LLM).
- **Auth/Proxy Logic**: `cloudflare-proxy/src/index.js` (Critical for security & JWT handling).
- **Card Templates**: `appPackage/cards/` (JSON source for Adaptive Cards).

## 🎨 Adaptive Cards Workflow
Adaptive Cards in Copilot responses are defined in `appPackage/ai-plugin.json` under `static_template`.
- **Source of Truth**: `appPackage/cards/*.json` contains the readable source.
- **Manual Sync Required**: If you edit a JSON file in `cards/`, you **MUST** manually copy the `body` content into the corresponding `static_template` in `ai-plugin.json`.

## 🐍 Python Code Interpreter
The agent uses Code Interpreter for all calculations to prevent hallucination:
- **Leegstandanalyse**: The system prompt includes a Python template for the "extern beheer check" logic
- **KPI Berekeningen**: All sums, averages, and joins are executed in Python
- **Anti-hallucination**: Never hardcode numbers - always compute from API data

## ⚠️ Manifest Constraints
- **Instructions Limit**: `appPackage/declarativeAgent.json` → `instructions` max **8000 characters**.
- **JSON Structure**: Validation is strict. Avoid duplicate keys.
- **Validation**: Run `Provision` (in Toolkit) to validate manifest changes against the server schema.

## 🏘️ Bloxs OData Conventions
- **Tenant-Specific Labels**: Status/State/WorkflowState are configurable. **Pattern**: Agent should query lookup endpoints (e.g., `getServiceTicketStates`) first to discover valid values, then filter.
- **Performance**: `FinancialMutations` is massive. ALWAYS use `$filter` and `$top=50-100`.
- **Filtering**:
    - **Lease History**: `getSalesContractLines` joined by `RealEstateObjectId` (efficient) vs scanning `SalesContracts` (slow).
    - **External Management**: Check `FinancialMutations` at complex/building level to detect if a property is financially managed externally.
- **Entities**:
    - `Units`/`Buildings` have `OwnerId`.
    - `Complexes` do NOT have `OwnerId` (must join down to units).
    - `RealEstateObjects` is the base table; use specific derived tables (`Units`) for richer data.

## 🛠️ Developer Workflow
1. **Edit Manifests**: `appPackage/*.json`
2. **Update Proxy**: `cd cloudflare-proxy && npm run dev` (local) or `npm run deploy`.
3. **Provision**: Use Teams Toolkit "Provision" to register changes. "Deploy" is not used for declarative agents.
4. **Debug**: Use "Preview in Copilot" (Microsoft 365 Agents Playground) to test prompts and tool calls.

## 🔐 Secrets & Safety
- **.env.user**: Contains local secrets. Never commit.
- **Cloudflare Secrets**: Manage via `wrangler secret put`.
- **Forbidden Data**: The proxy explicitly filters out specific sensitive owners (e.g., `FORBIDDEN_OWNER_NAMES` in `index.js`).

## M365 Copilot agent best practices (applied)
These patterns are implemented in this agent based on Microsoft documentation:

### Instructions structure
- **Use positive examples** showing *User input* → *Agent call* mappings.
- **Keep instructions concise** (current: ~2400 chars, limit: 8000).
- **Action-oriented** function descriptions in the plugin manifest.

### Query patterns for Bloxs OData
- **Vacancy detection**: `OccupationPercentage lt 1` finds candidates, but always cross-check `ActiveContractRentId` to avoid false positives. Exclude units with `[VERKOCHT]` in DisplayName (sold properties kept for history). Also exclude units where the parent complex/building has `FinancialMutations` - these are externally managed by another party.
- **Contract history**: Use `getSalesContractLines` filtered by `RealEstateObjectId` (not sampling join tables)
- **Tenant-specific labels**: Query lookup endpoints first (e.g., `getServiceTicketStates`) before filtering
- **Large tables**: Always use `$filter` and `$top<=100` for `FinancialMutations`

### Multi-turn conversation handling
The agent instructions include multi-step workflows for complex queries:
- Costs per property: invoices → invoice lines by ID
- Mortgages: ledger accounts → financial mutations
- WOZ by owner: units by owner → valuation values by RealEstateObjectId

### M365 Capabilities
The agent has access to Microsoft 365 data sources for correlation:
- **OneDriveAndSharePoint**: Search documents related to properties/tenants
- **Email**: Find emails about specific addresses or tenant names
- **TeamsMessages**: Search Teams chats for property-related discussions
- **WebSearch**: General web search for context

Use case: After querying Bloxs for a property address, search M365 for related emails/documents using that address or tenant name.

## Response Modes
The agent adapts its response depth based on query complexity:

| Mode | When to use | Approach |
|------|-------------|----------|
| **Quick** | Simple lookups, single facts | One API call, direct answer |
| **Deep** | KPIs, comparisons, trends | Multiple endpoints, calculations |
| **Research** | Helicopter view, recommendations | Full cross-entity analysis |

### Helicopter View Analyses
These insights combine data from multiple endpoints - not available in Bloxs GUI:

| Analysis | Endpoints Used | Value |
|----------|---------------|-------|
| Vacancy Financial Impact | Units + TheoreticalRentItems | €-cost of vacancy per owner/complex |
| Tenant Risk Score | OpenPositionDebtors + SalesContracts | Composite payment risk assessment |
| Owner Portfolio Comparison | Units + Debtors + Tickets + Valuations | Benchmark owners on KPIs |
| Problem Property ID | ServiceTickets + PurchaseInvoices | Flag properties >2x avg cost |
| Contract Renewal Value | SalesContracts + TheoreticalRentItems | Rent uplift opportunity at expiry |

## EntityLinkType Reference
For Notes and Tasks filtering:

| Entity | Value |
|--------|-------|
| Owner | 1 |
| Supplier | 2 |
| Organisation | 3 |
| Person | 4 |
| Building | 11 |
| Complex | 12 |
| Unit | 13 |
| Section | 14 |
| ServiceTicket | 63 |
| Installation | 67 |