/**
 * Bloxs OData Proxy for Cloudflare Workers
 * 
 * This worker handles JWT token management for the Bloxs API,
 * allowing Copilot to authenticate with a short API key.
 * 
 * Features:
 * - Automatic JWT token refresh
 * - Query-parameter guardrails (e.g., safe $orderby)
 * - Intelligent error handling with field suggestions
 */

// Token cache (in-memory, per worker instance)
let cachedToken = null;
let tokenExpiry = 0;

// Never return data referencing these owner names (case-insensitive exact match).
// This is enforced at the proxy layer across all endpoints.
const FORBIDDEN_OWNER_NAMES = new Set([
  'wals huren',
  'greenhorn properties bv'
]);

const ALLOWED_METHODS = new Set(['GET', 'OPTIONS']);

// Backward-compatible entity casing fixes (path segment -> canonical segment)
// Bloxs entity set names can be case-sensitive.
const ENTITY_PATH_ALIASES = {
  Owners: 'owners',
  OWNERS: 'owners',
  CommercialOverview: 'CommercialOverview',
  commercialoverview: 'CommercialOverview'
};

// Entity-specific query caps (lowercased entity name)
const ENTITY_TOP_CAPS = {
  financialmutations: 100,
  journalposttransactions: 100,
  salesinvoicelines: 200,
  purchaseinvoicelines: 200
};

const ENTITIES_REQUIRE_FILTER = new Set([
  'financialmutations',
  'journalposttransactions'
]);

const LEARN_INDEX_KEY = 'learn:index:v1';

// Known sortable fields per entity (fallback if metadata unavailable)
const KNOWN_SORTABLE_FIELDS = {
  'ServiceTickets': ['ServiceTicketId', 'Reference', 'ReportingDate', 'ClosingDate', 'Priority', 'RealEstateObjectName', 'TenantName', 'SupplierName', 'ServiceTicketStateName'],
  'ServiceTicketStates': ['ServiceTicketStateId', 'Name', 'SortOrder'],
  'ServiceTicketProblemCategories': ['ServiceTicketProblemCategoryId', 'Name', 'SortOrder'],
  'ServiceTicketCostCategories': ['ServiceTicketCostCategoryId', 'Name', 'SortOrder'],
  'Units': ['UnitId', 'DisplayName', 'Reference', 'CategoryName', 'OccupationPercentage', 'Owner', 'OwnerId', 'RentableFloorArea', 'ComplexName'],
  'SalesContracts': ['SalesContractId', 'Reference', 'StartDate', 'EndDate', 'RelationName', 'OwnerName', 'IsEnded'],
  'SalesContractRealestateObjects': ['SalesContractId', 'RealEstateObjectId', 'SortingIndex'],
  'SalesContractLineItems': ['SalesContractLineItemId', 'SalesContractId', 'RealEstateObjectId', 'RealEstateObjectName', 'Amount', 'StartDate', 'EndDate', 'LedgerAccountName'],
  'SalesContractLine': ['SalesContractLineId', 'SalesContractId', 'RealEstateObjectId', 'StartDate', 'EndDate', 'AmountExcl', 'AmountIncl', 'InvoiceInterval'],
  'FinancingContracts': ['FinancingContractId', 'Reference', 'StartDate', 'EndDate', 'PrincipalAmount', 'RealEstateObjectId'],
  'FinancialMutations': ['JournalPostId', 'TransactionDate', 'LedgerAccountCode', 'Amount', 'RealEstateObjectName', 'RelationName', 'FinancialYear', 'BookingDate'],
  'LedgerAccounts': ['LedgerAccountId', 'Code', 'Name', 'LedgerAccountType'],
  'Relations': ['RelationId', 'DisplayName', 'Reference', 'IsActive'],
  'Persons': ['PersonId', 'RelationId', 'DisplayName', 'FirstName', 'LastName', 'Email'],
  'Owners': ['OwnerId', 'RelationId', 'DisplayName', 'Reference', 'State', 'Email'],
  'Complexes': ['ComplexId', 'RealEstateObjectId', 'Reference', 'DisplayName', 'Owner', 'OccupationPercentage'],
  'SalesInvoices': ['SalesInvoiceId', 'Reference', 'InvoiceDate', 'DueDate', 'WorkflowState', 'TotalValueIncluding', 'OwnerName', 'RelationName', 'FinancialYear'],
  'SalesInvoiceLines': ['SalesInvoiceLineId', 'SalesInvoiceId', 'RealEstateObjectId', 'Amount', 'LedgerAccountName'],
  'OwnerSettlements': ['OwnerSettlementId', 'Reference', 'PeriodStart', 'PeriodEnd', 'OwnerName', 'TotalSettlementBalance'],
  'Tasks': ['TaskId', 'Status', 'Deadline', 'ShowFromDate', 'TaskCategory'],
  'Addresses': ['AddressId', 'Street', 'City', 'PostalCode', 'Country'],
  'Meters': ['MeterId', 'RealEstateObjectId', 'CategoryName', 'EANCode'],
  'MeterReadings': ['MeterReadingId', 'MeterId', 'ReadingDate', 'ReadingValue'],
  'IndexationMethods': ['IndexationMethodId', 'Name', 'Type'],
  'IndexationSeries': ['IndexationSeriesId', 'Name'],
  'IndexationSeriesValues': ['IndexationSeriesValueId', 'IndexationSeriesId', 'Year', 'Percentage'],
  'CommercialOverview': ['RealEstateObjectId', 'GroupRealEstateObjectName', 'Address', 'OwnerName', 'TenantName', 'IsOccupied', 'BareRent_Yearly_TotalAmountExcl', 'ContractStartDate', 'ContractEndDate', 'CategoryName', 'RealEstateObjectType'],
  'PropertyValuationValues': ['PropertyValuationValueId', 'RealEstateObjectId', 'ValuationYear', 'Value', 'ValuationTypeName'],
  'PropertyValuationTypes': ['PropertyValuationTypeId', 'Name'],
  'Notes': ['NoteId', 'CreatedOnTimeStamp', 'LastEditedOnTimeStamp', 'EntityLinkType', 'EntityId'],
  'OpenPositionDebtors': ['SalesInvoiceId', 'InvoiceDate', 'DueDate', 'Age', 'OutstandingAmount', 'RelationName', 'OwnerName'],
  'OpenPositionCreditors': ['PurchaseInvoiceId', 'InvoiceDate', 'DueDate', 'Age', 'OutstandingAmount', 'RelationName'],
  'TheoreticalRentItems': ['TheoreticalRentItemId', 'RealEstateObjectId', 'RealEstateObjectName', 'Amount', 'StartDate', 'EndDate'],
  'PurchaseOrders': ['PurchaseOrderId', 'Reference', 'OrderDate', 'RelationName', 'TotalAmount', 'WorkflowState'],
  'PurchaseOrderLines': ['PurchaseOrderLineId', 'PurchaseOrderId', 'RealEstateObjectId', 'Amount'],
  'Installations': ['InstallationId', 'RealEstateObjectId', 'Name', 'InstallationTypeName', 'NextMaintenanceOn'],
  'InstallationTypes': ['InstallationTypeId', 'Name'],
  'Projects': ['ProjectId', 'Reference', 'Name', 'StartDate', 'EndDate', 'Status'],
  'Buildings': ['BuildingId', 'RealEstateObjectId', 'Reference', 'DisplayName', 'DisplayAddress', 'OwnerId', 'Owner', 'CategoryName'],
  'Sections': ['SectionId', 'ComplexId', 'Reference', 'DisplayName'],
  'PurchaseInvoices': ['PurchaseInvoiceId', 'Reference', 'InvoiceDate', 'DueDate', 'WorkflowState', 'TotalValueIncluding', 'RelationName', 'RealEstateObjectName', 'FinancialYear'],
  'PurchaseInvoiceLines': ['PurchaseInvoiceLineId', 'PurchaseInvoiceId', 'RealEstateObjectId', 'RealEstateObjectName', 'Amount', 'LedgerAccountName'],
  'PurchaseContracts': ['PurchaseContractId', 'Reference', 'RelationName', 'StartDate', 'EndDate'],
  'PurchaseContractLines': ['PurchaseContractLineId', 'PurchaseContractId', 'RealEstateObjectId', 'Amount'],
  'RealEstateObjects': ['RealEstateObjectId', 'Reference', 'DisplayName', 'DisplayAddress', 'CategoryName'],
  'Journals': ['JournalId', 'Code', 'Name', 'JournalType'],
  'JournalPostTransactions': ['JournalPostId', 'TransactionDate', 'BookingDate', 'JournalId', 'Amount'],
  'BankAccounts': ['BankAccountId', 'IBAN', 'Name', 'OwnerId'],
  'OwnerBankAccounts': ['OwnerBankAccountId', 'OwnerId', 'IBAN', 'BankAccountName'],
  'Budgets': ['BudgetId', 'Name', 'Year', 'Amount'],
  'TaxRates': ['TaxRateId', 'Code', 'Name', 'Percentage'],
  'TeamMembers': ['TeamMemberId', 'RealEstateObjectId', 'PersonId', 'Role'],
  'WorkRegistrations': ['WorkRegistrationId', 'Date', 'Hours', 'PersonId'],
  'ControlList': ['ControlListId', 'Reference', 'Status', 'DueDate'],
  'RelationContactPersons': ['RelationContactPersonId', 'RelationId', 'PersonId'],
  'RelationCommunicationForms': ['RelationCommunicationFormId', 'RelationId', 'Type', 'Value'],
  'SupplierTypes': ['SupplierTypeId', 'Name'],
  'default': ['Id', 'Reference', 'DisplayName', 'Name']
};

const KNOWN_SORTABLE_FIELDS_LOWER = Object.fromEntries(
  Object.entries(KNOWN_SORTABLE_FIELDS).map(([key, value]) => [key.toLowerCase(), value])
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    if (!ALLOWED_METHODS.has(request.method)) {
      return methodNotAllowed();
    }

    // Validate the proxy API key
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonError('Missing or invalid Authorization header', 401);
    }

    const providedKey = authHeader.replace('Bearer ', '');
    if (providedKey !== env.PROXY_API_KEY) {
      return jsonError('Invalid API key', 401);
    }

    // Special endpoint: Get available entities and their fields (auth-gated)
    if (url.pathname === '/odatafeed/$metadata-summary') {
      return handleMetadataSummary(env);
    }

    // Special endpoint: Inspect learned schema-only insights (auth-gated)
    if (url.pathname === '/odatafeed/$learn-summary') {
      return handleLearnSummary(url, env);
    }

    const normalizedPathname = normalizeODataPathname(url.pathname);

    // Get or refresh the Bloxs JWT token
    let token;
    try {
      token = await getBloxsToken(env);
    } catch (error) {
      return jsonError(`Failed to get Bloxs token: ${error.message}`, 500);
    }

    // Extract entity name from path for validation
    const pathMatch = normalizedPathname.match(/\/odatafeed\/([^/?]+)/);
    const entityName = pathMatch ? pathMatch[1] : null;

    // Validate and fix query parameters if needed
    const fixedSearch = validateAndFixQuery(url.search, entityName);

    // Guardrail: require $filter for very large entities to avoid expensive scans/timeouts
    if (requiresFilter(entityName) && !new URLSearchParams(fixedSearch).has('$filter')) {
      return jsonError(
        `Missing required $filter for ${entityName}. Add a restrictive $filter (and keep $top <= ${getTopCap(entityName)}).`,
        400
      );
    }
    
    // Forward the request to Bloxs OData API
    const bloxsUrl = `${env.BLOXS_BASE_URL}${normalizedPathname}${fixedSearch}`;
    
    try {
      const response = await fetch(bloxsUrl, {
        method: request.method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const responseBody = await response.text();
      
      // If error, try to provide helpful information
      if (!response.ok) {
        return handleODataError(response.status, responseBody, entityName);
      }

      // Redact any rows that reference forbidden owner names.
      // Applies to all entity sets to ensure the proxy never returns data tied to those owners.
      const { body: redactedBody } = redactForbiddenOwnersFromODataJson(responseBody);

      // Opportunistically learn schema (field names only). Never store record values.
      if (ctx) {
        ctx.waitUntil(maybeLearnFromOData(entityName, redactedBody, env));
      }

      return new Response(redactedBody, {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type'
        }
      });
    } catch (error) {
      return jsonError(`Failed to fetch from Bloxs: ${error.message}`, 502);
    }
  }
};

/**
 * Validate and fix OData query parameters
 */
function validateAndFixQuery(search, entityName) {
  if (!search || !entityName) return search;
  
  const params = new URLSearchParams(search);
  const orderBy = params.get('$orderby');

  // Enforce $top caps (especially for large tables like FinancialMutations)
  const top = params.get('$top');
  if (top != null) {
    const parsedTop = Number.parseInt(top, 10);
    if (Number.isNaN(parsedTop) || parsedTop <= 0) {
      params.delete('$top');
    } else {
      const cap = getTopCap(entityName);
      if (parsedTop > cap) {
        params.set('$top', String(cap));
      }
    }
  }
  
  // If there's an $orderby, validate the field exists
  if (orderBy) {
    const knownFields = getKnownSortableFields(entityName);
    const fieldMap = buildCanonicalFieldMap(knownFields);

    // Support multi-field orderby: "Field1 desc, Field2 asc"
    const segments = orderBy
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const normalizedSegments = [];
    for (const segment of segments) {
      const [rawField, rawDirection] = segment.split(/\s+/, 2);
      const fieldName = (rawField || '').trim();
      const direction = (rawDirection || '').toLowerCase();

      const canonical = fieldMap.get(fieldName.toLowerCase());
      if (canonical) {
        normalizedSegments.push(direction === 'desc' ? `${canonical} desc` : canonical);
      }
    }

    if (normalizedSegments.length === 0) {
      const safeField = findSafeOrderByField(entityName);
      if (safeField) {
        const direction = orderBy.toLowerCase().includes('desc') ? ' desc' : '';
        params.set('$orderby', safeField + direction);
        console.log(`Fixed $orderby: ${orderBy} -> ${safeField}${direction}`);
      } else {
        params.delete('$orderby');
        console.log(`Removed invalid $orderby: ${orderBy}`);
      }
    } else {
      const normalized = normalizedSegments.join(', ');
      if (normalized !== orderBy) {
        params.set('$orderby', normalized);
        console.log(`Normalized $orderby: ${orderBy} -> ${normalized}`);
      }
    }
  }
  
  const newSearch = params.toString();
  return newSearch ? '?' + newSearch : '';
}

function buildCanonicalFieldMap(fields) {
  const map = new Map();
  for (const field of fields || []) {
    if (typeof field === 'string' && field.length > 0) {
      map.set(field.toLowerCase(), field);
    }
  }
  return map;
}

/**
 * Find a safe default field for ordering
 */
function findSafeOrderByField(entityName) {
  const knownFields = getKnownSortableFields(entityName);
  if (knownFields && knownFields.length > 0) {
    // Prefer Id or Reference fields for stable sorting
    const preferred = knownFields.find(f => f.endsWith('Id') || f === 'Reference');
    return preferred || knownFields[0];
  }
  return null;
}

function getKnownSortableFields(entityName) {
  const key = (entityName || '').toLowerCase();
  return KNOWN_SORTABLE_FIELDS_LOWER[key] || KNOWN_SORTABLE_FIELDS['default'];
}

function getTopCap(entityName) {
  const key = (entityName || '').toLowerCase();
  return ENTITY_TOP_CAPS[key] || 500;
}

function requiresFilter(entityName) {
  const key = (entityName || '').toLowerCase();
  return ENTITIES_REQUIRE_FILTER.has(key);
}

function normalizeODataPathname(pathname) {
  if (!pathname || !pathname.startsWith('/odatafeed/')) return pathname;
  const rest = pathname.slice('/odatafeed/'.length);
  const slashIndex = rest.indexOf('/');
  const firstSegment = slashIndex === -1 ? rest : rest.slice(0, slashIndex);

  // Don't rewrite special endpoints
  if (firstSegment.startsWith('$')) return pathname;

  const replacement = ENTITY_PATH_ALIASES[firstSegment];
  if (!replacement) return pathname;
  return `/odatafeed/${replacement}${slashIndex === -1 ? '' : rest.slice(slashIndex)}`;
}

function isLearningEnabled(env) {
  const flag = String(env?.ENABLE_LEARNING ?? '').toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

async function maybeLearnFromOData(entityName, responseBody, env) {
  try {
    if (!isLearningEnabled(env)) return;
    if (!env?.LEARNING_KV || typeof env.LEARNING_KV.get !== 'function') return;
    if (!entityName || typeof responseBody !== 'string') return;

    const parsed = JSON.parse(responseBody);
    const values = Array.isArray(parsed?.value) ? parsed.value : null;
    if (!values || values.length === 0) return;

    // Sample a few rows to infer top-level field names.
    const sampleCount = Math.min(values.length, 5);
    const discovered = new Set();
    for (let i = 0; i < sampleCount; i++) {
      const row = values[i];
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        for (const key of Object.keys(row)) {
          if (key && !key.startsWith('@odata.')) {
            discovered.add(key);
          }
        }
      }
    }

    if (discovered.size === 0) return;

    const entityKey = String(entityName).toLowerCase();
    const kvKey = `learn:entity:${entityKey}`;
    const now = Date.now();
    const existing = await env.LEARNING_KV.get(kvKey, { type: 'json' });

    const existingFields = new Set(Array.isArray(existing?.fields) ? existing.fields : []);
    let hasNewFields = false;
    for (const f of discovered) {
      if (!existingFields.has(f)) {
        existingFields.add(f);
        hasNewFields = true;
      }
    }

    const lastWriteMs = Number(existing?.lastWriteMs ?? 0);
    const shouldRefresh = !Number.isFinite(lastWriteMs) || (now - lastWriteMs) > 24 * 60 * 60 * 1000;
    if (!hasNewFields && !shouldRefresh) return;

    const record = {
      entity: entityName,
      entityKey,
      fields: Array.from(existingFields).sort(),
      fieldCount: existingFields.size,
      sampleCount,
      lastSeen: new Date(now).toISOString(),
      lastWriteMs: now
    };

    await env.LEARNING_KV.put(kvKey, JSON.stringify(record));

    // Maintain a lightweight index so we can enumerate learned entities.
    const index = await env.LEARNING_KV.get(LEARN_INDEX_KEY, { type: 'json' });
    const items = Array.isArray(index?.entities) ? index.entities : [];
    if (!items.includes(entityKey)) {
      items.push(entityKey);
      items.sort();
      await env.LEARNING_KV.put(LEARN_INDEX_KEY, JSON.stringify({ entities: items, lastWriteMs: now }));
    }
  } catch {
    // Never fail the request due to learning.
  }
}

async function handleLearnSummary(url, env) {
  if (!isLearningEnabled(env)) {
    return jsonError('Learning is disabled. Set ENABLE_LEARNING=true and bind LEARNING_KV to enable.', 400);
  }
  if (!env?.LEARNING_KV || typeof env.LEARNING_KV.get !== 'function') {
    return jsonError('Learning KV is not configured. Bind a KV namespace to LEARNING_KV.', 400);
  }

  const entity = url.searchParams.get('entity');
  if (entity) {
    const entityKey = entity.toLowerCase();
    const kvKey = `learn:entity:${entityKey}`;
    const record = await env.LEARNING_KV.get(kvKey, { type: 'json' });
    return new Response(JSON.stringify({ record: record || null }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const index = await env.LEARNING_KV.get(LEARN_INDEX_KEY, { type: 'json' });
  const entities = Array.isArray(index?.entities) ? index.entities : [];
  const records = await Promise.all(
    entities.map(async (k) => env.LEARNING_KV.get(`learn:entity:${k}`, { type: 'json' }))
  );

  return new Response(
    JSON.stringify(
      {
        learningEnabled: true,
        entityCount: entities.length,
        entities,
        records: records.filter(Boolean)
      },
      null,
      2
    ),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    }
  );
}

/**
 * Handle OData errors with helpful messages
 */
function handleODataError(status, responseBody, entityName) {
  let errorInfo = { error: 'Unknown error', details: responseBody };
  
  try {
    const parsed = JSON.parse(responseBody);
    if (parsed.error) {
      errorInfo = parsed.error;
    }
  } catch (e) {
    // Response wasn't JSON
  }
  
  // Extract field name from common OData errors
  const fieldMatch = responseBody.match(/property named '([^']+)'/);
  const invalidField = fieldMatch ? fieldMatch[1] : null;
  
  // Build helpful response
  const helpfulError = {
    error: errorInfo.message || errorInfo,
    status: status,
    entity: entityName,
    suggestion: null,
    availableFields: null
  };
  
  if (invalidField) {
    helpfulError.invalidField = invalidField;
    helpfulError.suggestion = `The field '${invalidField}' does not exist on ${entityName}.`;
    helpfulError.availableFields = getKnownSortableFields(entityName);
  }
  
  return new Response(JSON.stringify(helpfulError, null, 2), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/**
 * Provide a summary of available entities and their known fields
 */
async function handleMetadataSummary(env) {
  const summary = {
    description: 'Available OData entities and their commonly used fields',
    note: 'Important: many label fields (Status/State/WorkflowState/CategoryName/etc.) are tenant- and language-specific. Do not hardcode string equals filters; first discover valid values via lookup endpoints or by sampling recent records, then filter using the exact returned values.',
    agentRules: {
      batching: 'Never query per unit/property in a loop. Fetch each entity once ($top=200–500) and group/join in-memory.',
      financialMutations: 'FinancialMutations can be very large: always use a restrictive $filter and keep $top <= 100.'
    },
    businessInsights: {
      "Vacancy Rate": "Calculate: (Count of Units with OccupationPercentage < 1.0) / Total Units. High vacancy (>5%) requires attention.",
      "Financial Vacancy": "Sum of 'Potential Rent' for vacant units. Use TheoreticalRentItems for potential rent.",
      "Arrears (Achterstanden)": "Sum of 'OutstandingAmount' in OpenPositionDebtors where Age > 30 days.",
      "Maintenance Velocity": "Turnover rate of ServiceTickets. Calculate: (Closed Tickets last 30 days) / (New Tickets last 30 days).",
      "Cost per Unit": "Sum of FinancialMutations (Expense) linked to a Unit / Number of Units in that property.",
      "LTV (Loan to Value)": "Mortgage Amount (from FinancialMutations) / Property Value (from PropertyValuationValues). > 70% is high risk.",
      "Rent Coverage Ratio": "Annual Rent (from TheoreticalRentItems or SalesContractLines) / Annual Costs. < 1.2 is risky.",
      "Contract Renewal Risk": "Count of SalesContracts where EndDate is within 90 days. High count needs attention.",
      "Debtor Days Outstanding": "Average Age from OpenPositionDebtors. > 45 days indicates collection issues."
    },
    crossEntityInsights: {
      description: 'Advanced insights requiring reasoning across multiple entities - NOT available in Bloxs GUI',
      insights: {
        "Vacancy Financial Impact": {
          description: "Total potential rent lost due to vacancy",
          sources: ["Units (OccupationPercentage lt 1)", "TheoreticalRentItems (Amount per vacant UnitId)"],
          calculation: "Sum TheoreticalRentItems.Amount for all Units where OccupationPercentage < 1. Group by Owner/Complex for actionable breakdown.",
          businessValue: "Quantifies the €-cost of vacancy, enabling ROI analysis for marketing/renovation investments."
        },
        "Problem Property Identification": {
          description: "Properties with disproportionate maintenance cost or ticket volume",
          sources: ["ServiceTickets (count per RealEstateObjectName)", "PurchaseInvoices (sum per RealEstateObjectId)", "Units (for context)"],
          calculation: "Count open ServiceTickets per property. Sum PurchaseInvoices (maintenance-related) per property. Flag properties >2x average.",
          businessValue: "Identifies 'money pits' that may need major renovation or divestment consideration."
        },
        "Tenant Risk Score": {
          description: "Composite risk assessment per tenant based on payment behavior and lease terms",
          sources: ["OpenPositionDebtors (Age, OutstandingAmount per RelationId)", "SalesContracts (EndDate, RelationId)"],
          calculation: "Score = (Avg Payment Age / 30) + (OutstandingAmount / MonthlyRent) + (Months to Expiry < 6 ? 1 : 0). Higher = riskier.",
          businessValue: "Prioritize collection efforts and identify tenants needing retention or exit strategies."
        },
        "Net Operating Income (NOI) by Property": {
          description: "Property-level profitability analysis",
          sources: ["SalesContractLineItems or SalesInvoiceLines (income)", "FinancialMutations or PurchaseInvoiceLines (expenses by RealEstateObjectId)"],
          calculation: "NOI = Annual Rent Income - Operating Expenses (exclude financing). Group by property.",
          businessValue: "Identifies underperforming assets and validates investment decisions. GUI only shows totals."
        },
        "Owner Portfolio Comparison": {
          description: "Benchmark owners against each other on key metrics",
          sources: ["Units (grouped by OwnerId)", "OpenPositionDebtors", "ServiceTickets", "TheoreticalRentItems"],
          calculation: "Per Owner: Vacancy Rate, Arrears %, Tickets per Unit, Avg Rent/m². Rank owners.",
          businessValue: "For multi-owner managers: compare performance, justify management fees, identify best/worst performers."
        },
        "Lease Renewal Opportunity Value": {
          description: "Potential rent uplift from expiring contracts",
          sources: ["SalesContracts (EndDate in next 12 months)", "SalesContractLineItems (current rent)", "TheoreticalRentItems (market rent)"],
          calculation: "Gap = TheoreticalRent - CurrentContractRent for expiring contracts. Positive = upside opportunity.",
          businessValue: "Quantifies revenue upside from rent reversion. Prioritize renewals with biggest gaps."
        },
        "Concentration Risk Analysis": {
          description: "Portfolio dependency on single tenants/properties",
          sources: ["SalesContractLineItems or SalesInvoices (rent by RelationId)", "Units (value by property)"],
          calculation: "Top 5 tenants as % of total rent. Top 5 properties as % of total value. >30% single = high risk.",
          businessValue: "Critical for portfolio risk management. Not visible in standard Bloxs reporting."
        },
        "Deferred Maintenance Liability": {
          description: "Estimated cost of open maintenance backlog",
          sources: ["ServiceTickets (open)", "ServiceTicketCostCategories", "PurchaseInvoices (historical avg per category)"],
          calculation: "Open Tickets × Avg Cost per Category (from historical PurchaseInvoices linked to tickets).",
          businessValue: "Estimates hidden liability. Essential for property valuations and sale negotiations."
        },
        "Cash Collection Efficiency Trend": {
          description: "Are we getting better or worse at collecting rent?",
          sources: ["OpenPositionDebtors (snapshot)", "SalesInvoices (historical, by month)"],
          calculation: "Monthly: (Collected / Invoiced) %. Plot 12-month trend.",
          businessValue: "Early warning for deteriorating tenant quality or economic conditions."
        },
        "Indexation Impact Forecast": {
          description: "Projected rent increase from upcoming indexations",
          sources: ["SalesContracts (with IndexationMethodId)", "IndexationSeries + IndexationSeriesValues (latest %)", "SalesContractLineItems (current rent)"],
          calculation: "For contracts with upcoming indexation: CurrentRent × LatestIndexPercentage = Increase.",
          businessValue: "Forecast revenue growth from CPI/indexation. Budget planning essential."
        },
        "CAPEX vs OPEX Trend": {
          description: "Capital expenditure vs operating expense balance",
          sources: ["FinancialMutations (by LedgerAccountCode)", "LedgerAccounts (to classify CAPEX vs OPEX)"],
          calculation: "Classify ledger accounts as CAPEX (improvements, renovations) or OPEX (repairs, services). Plot ratio over time.",
          businessValue: "Indicates maintenance strategy: reactive (high OPEX) vs proactive (balanced CAPEX). Affects asset value."
        },
        "Installation Risk Matrix": {
          description: "Equipment approaching end-of-life or overdue maintenance",
          sources: ["Installations (NextMaintenanceOn, InstallationTypeName)", "Units (for property context)"],
          calculation: "Flag: Overdue maintenance, Age > Expected Lifespan (by type). Cross with property value.",
          businessValue: "Prevent costly emergency repairs. Plan CAPEX reserves."
        }
      }
    },
    entities: {
      Units: {
        description: 'Rental units (apartments, offices, retail spaces). Core entity for occupancy analysis.',
        sortableFields: KNOWN_SORTABLE_FIELDS['Units'],
        filterExamples: ["OccupationPercentage lt 1 (Vacant)", "OwnerId eq 515", "contains(CategoryName,'Winkel')"],
        note: 'Use OwnerId to filter by owner. RealEstateObjects base table does NOT have OwnerId - use Units instead. Use OccupationPercentage < 1 to find vacant units.'
      },
      SalesContracts: {
        description: 'Rent contracts with tenants.',
        sortableFields: KNOWN_SORTABLE_FIELDS['SalesContracts'],
        filterExamples: ["IsEnded eq false", "EndDate lt 2026-06-01 (Upcoming Expiration)"],
        joinInfo: 'Use SalesContractRealestateObjects to link to Units. Use RelationId to link to Persons/Tenants.'
      },
      SalesContractRealestateObjects: {
        description: 'JOIN TABLE linking SalesContracts to RealEstateObjects/Units',
        sortableFields: KNOWN_SORTABLE_FIELDS['SalesContractRealestateObjects'],
        joinInstructions: 'SalesContracts.SalesContractId → this.SalesContractId, this.RealEstateObjectId → Units.UnitId'
      },
      Persons: {
        description: 'Contact details for people (tenants, contacts)',
        sortableFields: KNOWN_SORTABLE_FIELDS['Persons'],
        filterExamples: ["contains(DisplayName, 'naam')", "RelationId eq 123"],
        joinInfo: 'RelationId links to SalesContracts.RelationId'
      },
      Complexes: {
        description: 'Buildings/complexes containing multiple units',
        sortableFields: KNOWN_SORTABLE_FIELDS['Complexes'],
        filterExamples: ["OccupationPercentage lt 1"]
      },
      FinancingContracts: {
        description: 'Mortgages and loans on properties (hypotheken/leningen) - VAAK LEEG!',
        sortableFields: KNOWN_SORTABLE_FIELDS['FinancingContracts'],
        filterExamples: ["IsEnded eq false"],
        joinInfo: 'RealEstateObjectId links to Units.UnitId',
        note: 'WAARSCHUWING: Deze tabel is meestal leeg! Hypotheekdata staat bijna altijd in FinancialMutations. Workflow: 1) Query LedgerAccounts met contains(Name,\"hypothe\") om codes te vinden, 2) Query FinancialMutations met die LedgerAccountCode.'
      },
      FinancialMutations: {
        description: 'General ledger transactions - THE SOURCE for mortgage/loan payments!',
        sortableFields: KNOWN_SORTABLE_FIELDS['FinancialMutations'],
        filterExamples: ["FinancialYear eq 2025", "contains(RealEstateObjectName,'straat')"],
        note: 'Always use a restrictive $filter and small $top. For mortgage questions: first discover the relevant ledger account code(s) via LedgerAccounts, then filter here. Contains RealEstateObjectName, RelationName (bank), Amount.'
      },
      LedgerAccounts: {
        description: 'Chart of accounts (grootboekrekeningen)',
        sortableFields: KNOWN_SORTABLE_FIELDS['LedgerAccounts'],
        filterExamples: ["contains(Name,'hypothe')", "contains(Name,'lening')"],
        note: "Do not hardcode ledger codes. First discover the right Code(s) by querying this entity (e.g. contains(Name,'hypothe') / contains(Name,'rente')), then use those Code(s) in FinancialMutations filters."
      },
      Meters: {
        description: 'Utility meters (electricity, gas, water)',
        sortableFields: KNOWN_SORTABLE_FIELDS['Meters'],
        joinInfo: 'RealEstateObjectId links to Units.UnitId'
      },
      PropertyValuationValues: {
        description: 'WOZ values and other property valuations',
        sortableFields: KNOWN_SORTABLE_FIELDS['PropertyValuationValues'],
        filterExamples: ["ValuationYear eq 2025", "contains(RealEstateObjectName,'straat')", "RealEstateObjectId eq 123"],
        joinInfo: 'RealEstateObjectId links to Units.UnitId',
        note: 'For WOZ by owner: first query Units with OwnerId eq X to get UnitIds, then filter PropertyValuationValues by those RealEstateObjectIds.'
      },
      ServiceTicketStates: {
        description: 'Valid maintenance ticket states (use this to discover the exact names/ids for filtering ServiceTickets)',
        sortableFields: KNOWN_SORTABLE_FIELDS['ServiceTicketStates'],
        filterExamples: ["contains(Name,'act')", "contains(Name,'open')", "contains(Name,'afger')"],
        note: 'State names are tenant- and language-specific. Query here first, then filter ServiceTickets by ServiceTicketStateName or state id fields if available.'
      },
      ServiceTickets: {
        description: 'Maintenance service tickets (NO JOIN NEEDED - contains all names)',
        sortableFields: KNOWN_SORTABLE_FIELDS['ServiceTickets'],
        filterExamples: ["ClosingDate eq null", "ReportingDate ge 2025-01-01", "contains(ServiceTicketStateName,'Act')"],
        note: "Already includes RealEstateObjectName, TenantName, SupplierName. For 'open/active' tickets: first query ServiceTicketStates to find valid state names, then filter by ServiceTicketStateName."
      },
      Notes: {
        description: 'Notes attached to entities',
        sortableFields: KNOWN_SORTABLE_FIELDS['Notes'],
        filterExamples: ["EntityLinkType eq 'Person'", "EntityId eq 123"],
        joinInfo: 'EntityId + EntityLinkType links to Person/Organisation'
      },
      OpenPositionDebtors: {
        description: 'Outstanding receivables (debtor aging)',
        sortableFields: KNOWN_SORTABLE_FIELDS['OpenPositionDebtors'],
        filterExamples: ["Age gt 90", "OutstandingAmount gt 1000"]
      },
      OpenPositionCreditors: {
        description: 'Outstanding payables (creditor aging)',
        sortableFields: KNOWN_SORTABLE_FIELDS['OpenPositionCreditors'],
        filterExamples: ["Age gt 30"]
      },
      Owners: {
        description: 'Property owners with contact info and company details',
        sortableFields: KNOWN_SORTABLE_FIELDS['Owners'],
        filterExamples: ["contains(State,'Act')", "contains(DisplayName, 'BV')"]
      },
      SalesInvoices: {
        description: 'Sales invoices to tenants',
        sortableFields: KNOWN_SORTABLE_FIELDS['SalesInvoices'],
        filterExamples: ["InvoiceDate ge 2025-01-01", "FinancialYear eq 2025"],
        note: "WorkflowState values are tenant- and language-specific. To filter by state, first sample recent invoices ($top=10, $select=SalesInvoiceId,WorkflowState,InvoiceDate) to discover valid values, then filter using the exact returned value(s)."
      },
      OwnerSettlements: {
        description: 'Owner settlements/statements (afrekeningen)',
        sortableFields: KNOWN_SORTABLE_FIELDS['OwnerSettlements'],
        filterExamples: ["PeriodStart ge 2025-01-01", "PeriodEnd le 2025-12-31"]
      },
      Tasks: {
        description: 'System tasks and reminders',
        sortableFields: KNOWN_SORTABLE_FIELDS['Tasks'],
        filterExamples: ["Deadline le 2026-06-01", "ShowFromDate le 2026-01-31"],
        note: "Status values can vary by tenant/language. If you need status-based filtering, first sample recent tasks ($top=10, $select=TaskId,Status,Deadline) to discover valid values."
      },
      Addresses: {
        description: 'Address records with coordinates',
        sortableFields: KNOWN_SORTABLE_FIELDS['Addresses'],
        filterExamples: ["City eq 'Amsterdam'"]
      },
      MeterReadings: {
        description: 'Meter reading values over time',
        sortableFields: KNOWN_SORTABLE_FIELDS['MeterReadings'],
        filterExamples: ["ReadingDate gt 2025-01-01"],
        joinInfo: 'MeterId links to Meters.MeterId'
      },
      IndexationMethods: {
        description: 'Rent indexation methods (CPI, fixed, etc)',
        sortableFields: KNOWN_SORTABLE_FIELDS['IndexationMethods'],
        filterExamples: ["contains(Name,'CPI')"]
      },
      CommercialOverview: {
        description: 'Commercial summary per property - NO JOIN NEEDED! Contains tenant, owner, rent, contract dates',
        sortableFields: KNOWN_SORTABLE_FIELDS['CommercialOverview'],
        keyFields: ['RealEstateObjectId', 'Address', 'OwnerName', 'TenantName', 'IsOccupied', 'BareRent_Yearly_TotalAmountExcl', 'ContractStartDate', 'ContractEndDate', 'CategoryName'],
        filterExamples: ["IsOccupied eq true", "IsOccupied eq false"],
        note: 'Excellent for quick portfolio overview. IMPORTANT: rent field is BareRent_Yearly_TotalAmountExcl (not BareRent). Also has ServiceCosts_Yearly_TotalAmountExcl, ContractReference, RentableFloorArea.'
      },
      SalesInvoiceLines: {
        description: 'Individual invoice lines with property and ledger account',
        joinInfo: 'SalesInvoiceId → SalesInvoices, RealEstateObjectId → Units, LedgerAccountId → LedgerAccounts'
      },
      PurchaseInvoices: {
        description: 'Purchase invoices from suppliers - KEY for cost analysis',
        sortableFields: KNOWN_SORTABLE_FIELDS['PurchaseInvoices'],
        keyFields: ['PurchaseInvoiceId', 'Reference', 'InvoiceDate', 'TotalValueIncluding', 'RelationName', 'RealEstateObjectName', 'FinancialYear'],
        filterExamples: ["InvoiceDate ge 2025-01-01", "FinancialYear eq 2025", "contains(RealEstateObjectName,'straat')"],
        joinInfo: 'RelationId → Relations (supplier), ServiceTicketId → ServiceTickets',
        note: "Contains RealEstateObjectName directly for many invoices. WorkflowState is tenant-specific - sample first. Use for cost analysis per property."
      },
      PurchaseInvoiceLines: {
        description: 'Individual purchase invoice lines with property breakdown',
        sortableFields: KNOWN_SORTABLE_FIELDS['PurchaseInvoiceLines'],
        keyFields: ['PurchaseInvoiceLineId', 'PurchaseInvoiceId', 'RealEstateObjectId', 'RealEstateObjectName', 'Amount'],
        filterExamples: ["RealEstateObjectId eq 123", "Amount gt 1000"],
        joinInfo: 'PurchaseInvoiceId → PurchaseInvoices, RealEstateObjectId → Units',
        note: 'Use when PurchaseInvoices.RealEstateObjectName is null - lines often have property details.'
      },
      TheoreticalRentItems: {
        description: 'Potential/market rent per property - key for vacancy impact analysis',
        sortableFields: KNOWN_SORTABLE_FIELDS['TheoreticalRentItems'],
        filterExamples: ["RealEstateObjectId eq 123", "Amount gt 0"],
        joinInfo: 'RealEstateObjectId → Units.UnitId',
        note: 'Use this to calculate financial impact of vacancy: sum Amount for vacant units.'
      },
      Installations: {
        description: 'Equipment and installations (CV, lift, etc) with maintenance schedules',
        sortableFields: KNOWN_SORTABLE_FIELDS['Installations'],
        filterExamples: ["NextMaintenanceOn lt 2026-06-01"],
        joinInfo: 'RealEstateObjectId → Units, SupplierId → Relations (maintenance company)',
        note: 'Useful for preventive maintenance planning. Filter by NextMaintenanceOn for upcoming maintenance.'
      },
      Projects: {
        description: 'Renovation/development projects with budgets and timelines',
        sortableFields: KNOWN_SORTABLE_FIELDS['Projects'],
        filterExamples: ["Status eq 'Active'", "EndDate gt 2026-01-01"],
        note: 'Status values may be tenant-specific. Sample first to discover valid values.'
      },
      PurchaseContracts: {
        description: 'Contracts with suppliers (cleaning, maintenance, etc)',
        joinInfo: 'RelationId → Relations (supplier), OwnerId → Owners'
      },
      PurchaseContractLines: {
        description: 'Line items on purchase contracts',
        joinInfo: 'PurchaseContractId → PurchaseContracts, RealEstateObjectId → Units'
      },
      OwnerBankAccounts: {
        description: 'Bank accounts per owner',
        joinInfo: 'OwnerId → Owners'
      },
      Relations: {
        description: 'Base table for all relation types (persons, organisations, suppliers, owners)',
        sortableFields: KNOWN_SORTABLE_FIELDS['Relations'],
        note: 'Use specific tables like Persons, Owners for more details'
      },
      SalesContractLines: {
        description: 'Rent components per contract (bare rent, service costs, etc)',
        joinInfo: 'SalesContractId → SalesContracts, RealEstateObjectId → Units'
      },
      SalesContractLineItems: {
        description: 'Detailed rent line items with amounts - KEY for rent analysis per property/owner',
        sortableFields: KNOWN_SORTABLE_FIELDS['SalesContractLineItems'],
        keyFields: ['SalesContractLineItemId', 'SalesContractId', 'RealEstateObjectId', 'RealEstateObjectName', 'Amount', 'StartDate', 'EndDate'],
        filterExamples: ["Amount gt 0", "contains(RealEstateObjectName,'straat')", "EndDate ge 2025-01-01"],
        note: 'Contains RealEstateObjectName directly - no join needed for property info. Use for rent totals per property/owner.'
      },
      Buildings: {
        description: 'Building-level real estate objects (standalone properties)',
        sortableFields: KNOWN_SORTABLE_FIELDS['Buildings'],
        filterExamples: ["OwnerId eq 515", "contains(DisplayName,'straat')", "contains(Owner,'Roks')"],
        keyFields: ['BuildingId', 'RealEstateObjectId', 'Reference', 'DisplayName', 'DisplayAddress', 'OwnerId', 'Owner'],
        note: 'Buildings have OwnerId directly. Use DisplayAddress for address info, NOT Address.'
      },
      Sections: {
        description: 'Sections within complexes',
        joinInfo: 'ComplexId → Complexes'
      },
      RealEstateObjects: {
        description: 'Base table for all property types (Buildings, Complexes, Units, Sections)',
        sortableFields: KNOWN_SORTABLE_FIELDS['RealEstateObjects'],
        keyFields: ['RealEstateObjectId', 'Reference', 'DisplayName', 'DisplayAddress', 'CategoryName'],
        note: 'Base table - use specific tables (Units, Buildings, Complexes) for OwnerId filtering. Address info is in DisplayAddress field.'
      }
    },
    ownerWorkflows: {
      description: 'Step-by-step workflows for owner-based queries - CRITICAL: never loop per property!',
      'Mortgages by Owner': {
        steps: [
          '1. Query Owners with contains(DisplayName,"eigenaarsnaam") to get OwnerId',
          '2. Query Units OR Buildings with OwnerId eq {id}, $top=200, $select=UnitId,RealEstateObjectId,DisplayName,DisplayAddress,Owner',
          '3. Query LedgerAccounts with contains(Name,"hypothe") OR contains(Name,"lening") to get ledger Codes',
          '4. Query FinancialMutations with FinancialYear eq 2025 and LedgerAccountCode in discovered codes, $top=100',
          '5. Match mutations to properties from step 2 by RealEstateObjectName in-memory'
        ],
        note: 'Do NOT loop per property! Fetch all in one query and match in-memory.'
      },
      'Properties by Owner': {
        steps: [
          '1. Query Owners to get OwnerId',
          '2. Query Units with OwnerId eq {id}, $select=UnitId,DisplayName,DisplayAddress,ComplexName,OccupationPercentage,CategoryName',
          '3. OR Query Buildings with OwnerId eq {id} for standalone buildings'
        ],
        note: 'Units and Buildings have OwnerId. Complexes/Sections do NOT have OwnerId directly.'
      },
      'Contracts by Owner': {
        steps: [
          '1. Query Owners to get OwnerId',
          '2. Query Units with OwnerId eq {id}, $select=UnitId,DisplayName,ActiveContractRentId',
          '3. Query SalesContracts with $top=200, $select=SalesContractId,Reference,RelationName,StartDate,EndDate,IsEnded',
          '4. Match contracts to units by SalesContractId = ActiveContractRentId in-memory'
        ],
        alternativeMethod: 'OR: Query SalesContractLineItems ($top=300) which contains RealEstateObjectName directly, then filter in-memory by property names from step 2.',
        note: 'SalesContracts has OwnerName field - can also filter directly: contains(OwnerName,"eigenaarsnaam")'
      },
      'Service Tickets by Owner': {
        steps: [
          '1. Query Units with OwnerId eq {id}, $select=UnitId,DisplayName,RealEstateObjectId',
          '2. Query ServiceTickets ($top=200, $select=ServiceTicketId,Reference,RealEstateObjectName,ServiceTicketStateName,ReportingDate)',
          '3. Match tickets to units by comparing RealEstateObjectName to DisplayName in-memory'
        ],
        note: 'ServiceTickets has RealEstateObjectName - no join table needed. Do NOT filter per property!'
      },
      'Costs by Owner (Purchase Invoices)': {
        steps: [
          '1. Query Units with OwnerId eq {id}, $select=UnitId,DisplayName,RealEstateObjectId',
          '2. Query PurchaseInvoices with FinancialYear eq 2025, $top=200, $select=PurchaseInvoiceId,Reference,InvoiceDate,TotalValueIncluding,RealEstateObjectName,RelationName',
          '3. Match invoices to units by RealEstateObjectName in-memory',
          '4. If RealEstateObjectName often null: Query PurchaseInvoiceLines instead for property breakdown'
        ],
        note: 'PurchaseInvoices often has RealEstateObjectName. Use PurchaseInvoiceLines for line-level property detail.'
      },
      'WOZ Values by Owner': {
        steps: [
          '1. Query Units with OwnerId eq {id}, $select=UnitId,RealEstateObjectId,DisplayName,DisplayAddress',
          '2. Query PropertyValuationValues with ValuationYear eq 2025 or 2026, $top=200',
          '3. Match valuations to units by RealEstateObjectId in-memory'
        ],
        note: 'PropertyValuationValues uses RealEstateObjectId, NOT UnitId. Match via RealEstateObjectId from Units.'
      },
      'Arrears by Owner (Achterstanden)': {
        steps: [
          '1. Query Units with OwnerId eq {id}, $select=UnitId,DisplayName,ActiveContractRentId,ActiveContractRentTenantId',
          '2. Query OpenPositionDebtors with Age gt 0, $top=200, $select=SalesInvoiceId,RelationId,RelationName,OutstandingAmount,Age,DueDate',
          '3. Match debtors to units by RelationId = ActiveContractRentTenantId in-memory'
        ],
        alternativeMethod: 'OR: Query SalesInvoices with OwnerName filter, then match to OpenPositionDebtors by SalesInvoiceId.',
        note: 'OpenPositionDebtors has RelationId (tenant) and Age (days overdue).'
      },
      'Rent per Property (Huurinkomsten)': {
        steps: [
          '1. Query SalesContractLineItems with $top=500, $select=SalesContractLineItemId,RealEstateObjectId,RealEstateObjectName,Amount,StartDate,EndDate',
          '2. Group by RealEstateObjectName and sum Amount for annual rent per property',
          '3. If owner-specific: first get property list from Units with OwnerId, then filter in-memory'
        ],
        note: 'SalesContractLineItems contains RealEstateObjectName directly. Amount is typically monthly rent.'
      },
      'Meters & Installations by Owner': {
        steps: [
          '1. Query Units with OwnerId eq {id}, $select=UnitId,RealEstateObjectId,DisplayName',
          '2. Query Meters OR Installations ($top=200), which have RealEstateObjectId',
          '3. Match by RealEstateObjectId in-memory'
        ],
        note: 'Meters/Installations link via RealEstateObjectId to Units.'
      },
      'Expiring Contracts by Owner': {
        steps: [
          '1. Query SalesContracts with EndDate lt 2027-01-01 and IsEnded eq false, $top=100',
          '2. Filter by OwnerName if available: contains(OwnerName,"eigenaarsnaam")',
          '3. OR: Query Units with OwnerId, then match via SalesContractRealestateObjects'
        ],
        note: 'SalesContracts often has OwnerName field - check first with $top=5 to see available fields.'
      }
    },
    commonFilterIssues: {
      description: 'Common filtering problems and solutions',
      'Field not found: Address': {
        problem: 'Many entities use DisplayAddress, not Address',
        solution: 'Use DisplayAddress instead of Address for Units, Buildings, RealEstateObjects'
      },
      'Field not found: Name': {
        problem: 'Many entities use DisplayName, not Name',
        solution: 'Use DisplayName instead of Name for most entities'
      },
      'Field not found: Id': {
        problem: 'Each entity has its own Id field name (UnitId, BuildingId, etc.)',
        solution: 'Use the specific Id field: UnitId, BuildingId, SalesContractId, etc.'
      },
      'No results for Status/State filter': {
        problem: 'Status/State/WorkflowState values are tenant- and language-specific',
        solution: 'First sample with $top=10 to discover valid values, then use exact match'
      },
      'RealEstateObjectName is null': {
        problem: 'Not all records have RealEstateObjectName populated',
        solution: 'For invoices: check PurchaseInvoiceLines. For tickets: usually populated. For mutations: usually populated.'
      },
      'OwnerId filter returns empty': {
        problem: 'Not all entities have OwnerId directly',
        solution: 'OwnerId exists on: Units, Buildings. NOT on: Complexes, Sections, RealEstateObjects base table.'
      },
      'Cannot sort by field X': {
        problem: 'Not all fields support $orderby',
        solution: 'Use Id or Reference fields for sorting. Avoid sorting by calculated or nullable fields.'
      }
    },
    commonJoins: {
      // === TENANT / HUURDER RELATIES ===
      'Tenant to Property': 'SalesContracts.SalesContractId → SalesContractRealestateObjects.SalesContractId, then RealEstateObjectId → Units.UnitId',
      'Tenant Contact Info': 'SalesContracts.RelationId → Persons.RelationId (for phone, email)',
      'Tenant Address': 'SalesContracts.RelationId → Addresses (filter EntityLinkType=Person/Organisation, EntityId=RelationId)',
      'Tenant Invoices': 'SalesContracts.RelationId → SalesInvoices.RelationId',
      'Tenant Outstanding': 'SalesContracts.RelationId → OpenPositionDebtors.RelationId',
      
      // === PROPERTY / PAND RELATIES ===
      'Property WOZ Value': 'Units.UnitId → PropertyValuationValues.RealEstateObjectId',
      'Property Meters': 'Units.UnitId → Meters.RealEstateObjectId → MeterReadings.MeterId',
      'Property Installations': 'Units.UnitId → Installations.RealEstateObjectId',
      'Property ServiceTickets': 'Units.UnitId → ServiceTickets.RealEstateObjectId',
      'Property in Complex': 'Units.ComplexId → Complexes.ComplexId',
      'Property Owner': 'Units.OwnerId → Owners.OwnerId',
      'Property Financials': 'Units.UnitId → FinancialMutations.RealEstateObjectId',
      
      // === OWNER / EIGENAAR RELATIES ===
      'Owner Contact Info': 'Owners.RelationId → Persons.RelationId OR Relations.RelationId',
      'Owner Settlements': 'Owners.OwnerId → OwnerSettlements.OwnerId',
      'Owner Properties': 'Owners.OwnerId → Units (filter OwnerId) OR RealEstateObjects',
      'Owner Bank Accounts': 'Owners.OwnerId → OwnerBankAccounts.OwnerId',
      
      // === INVOICE / FACTUUR RELATIES ===
      'SalesInvoice Lines': 'SalesInvoices.SalesInvoiceId → SalesInvoiceLines.SalesInvoiceId',
      'SalesInvoice to Property': 'SalesInvoiceLines.RealEstateObjectId → Units.UnitId',
      'SalesInvoice to Contract': 'SalesInvoices.SalesContractId → SalesContracts.SalesContractId',
      'PurchaseInvoice Lines': 'PurchaseInvoices.PurchaseInvoiceId → PurchaseInvoiceLines.PurchaseInvoiceId',
      'PurchaseInvoice to Supplier': 'PurchaseInvoices.RelationId → Relations.RelationId',
      'PurchaseInvoice to Ticket': 'PurchaseInvoices.ServiceTicketId → ServiceTickets.ServiceTicketId',
      
      // === NOTES / NOTITIES ===
      'Person Notes': 'Notes (filter EntityLinkType=Person, EntityId=PersonId)',
      'Property Notes': 'Notes (filter EntityLinkType=Unit/Building/Complex, EntityId=RealEstateObjectId)',
      'Contract Notes': 'Notes (filter EntityLinkType=PrivateRentSalesContract, EntityId=SalesContractId)',
      
      // === TASKS / TAKEN ===
      'Task to Entity': 'Tasks.ReferenceToEntityId + ReferenceToEntityLinkType → linked entity',
      
      // === FINANCIALS ===
      'Mutation to LedgerAccount': 'FinancialMutations.LedgerAccountId → LedgerAccounts.LedgerAccountId',
      'Mutation to Relation': 'FinancialMutations.RelationId → Relations.RelationId (e.g., bank name)',
      'Mortgage Payments': 'FinancialMutations (filter using the mortgage-interest ledger Code discovered via LedgerAccounts) → shows bank, property, amount'
    },
    
    entityLinkTypes: {
      description: 'Values for EntityLinkType field in Notes, Tasks, Addresses',
      types: {
        'Owner': 1, 'Supplier': 2, 'Organisation': 3, 'Person': 4, 'EstateAgent': 5, 'Financier': 6,
        'Building': 11, 'Complex': 12, 'Unit': 13, 'Section': 14, 'Project': 15,
        'GeneralSalesContract': 21, 'PrivateRentSalesContract': 23, 'CommercialRentSalesContract': 25,
        'ServiceSalesContract': 27, 'SupplierContract': 28,
        'SalesInvoice': 41, 'PurchaseInvoice': 42,
        'ServiceTicket': 63, 'Installation': 67
      }
    },
    queryParameters: {
      '$filter': 'Filter results (e.g., OccupationPercentage lt 1)',
      '$select': 'Select specific fields (e.g., DisplayName,Reference)',
      '$orderby': 'Sort results (e.g., StartDate desc)',
      '$top': 'Limit results (e.g., 10)',
      '$skip': 'Skip results for pagination',
      '$count': 'Include total count (true/false)',
      '$expand': 'Expand related entities'
    }
  };
  
  return new Response(JSON.stringify(summary, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/**
 * Get a valid Bloxs JWT token, refreshing if needed
 */
async function getBloxsToken(env) {
  const now = Date.now();
  
  // Return cached token if still valid (with 5 minute buffer)
  if (cachedToken && tokenExpiry > now + 300000) {
    return cachedToken;
  }

  // Request new token from Bloxs
  const response = await fetch(`${env.BLOXS_BASE_URL}/Authorization`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      apiKey: env.BLOXS_API_KEY,
      apiSecret: env.BLOXS_API_SECRET
    })
  });

  if (!response.ok) {
    throw new Error(`Bloxs auth failed: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = data.token;

  // Prefer JWT exp (if token is a JWT); fallback to Bloxs expiration string.
  const jwtExpiryMs = getJwtExpiryMs(cachedToken);
  if (jwtExpiryMs) {
    tokenExpiry = jwtExpiryMs;
  } else {
    const parsedExpiry = parseBloxsExpirationMs(data.expiration);
    tokenExpiry = parsedExpiry || (now + 55 * 60 * 1000);
  }

  return cachedToken;
}

function getJwtExpiryMs(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadJson = base64UrlDecodeToString(parts[1]);
    const payload = JSON.parse(payloadJson);
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
  } catch {
    // ignore
  }
  return null;
}

function base64UrlDecodeToString(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function parseBloxsExpirationMs(expiration) {
  if (!expiration || typeof expiration !== 'string') return null;
  // Common observed format: "01/10/2026 16:42:26" (NL often DD/MM/YYYY)
  // Try DD/MM/YYYY first; if that fails, try MM/DD/YYYY.
  const match = expiration.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;

  const a = Number.parseInt(match[1], 10);
  const b = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4] ?? '0', 10);
  const minute = Number.parseInt(match[5] ?? '0', 10);
  const second = Number.parseInt(match[6] ?? '0', 10);

  const ddFirst = toUtcMs(year, b, a, hour, minute, second);
  if (ddFirst) return ddFirst;

  const mmFirst = toUtcMs(year, a, b, hour, minute, second);
  if (mmFirst) return mmFirst;

  return null;
}

function toUtcMs(year, month, day, hour, minute, second) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Handle CORS preflight requests
 */
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

function methodNotAllowed() {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    }
  });
}

/**
 * Return a JSON error response
 */
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function redactForbiddenOwnersFromODataJson(responseBody) {
  if (!responseBody || typeof responseBody !== 'string') {
    return { body: responseBody };
  }

  let parsed;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return { body: responseBody };
  }

  const values = Array.isArray(parsed?.value) ? parsed.value : null;
  if (!values) {
    return { body: responseBody };
  }

  const filtered = values.filter((row) => !objectContainsForbiddenOwnerName(row));
  if (filtered.length === values.length) {
    return { body: responseBody };
  }

  const updated = { ...parsed, value: filtered };
  return { body: JSON.stringify(updated) };
}

function objectContainsForbiddenOwnerName(value) {
  const seen = new Set();
  const stack = [value];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current == null) continue;

    if (typeof current === 'string') {
      const normalized = current.trim().toLowerCase();
      if (FORBIDDEN_OWNER_NAMES.has(normalized)) return true;
      continue;
    }

    if (typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    for (const key of Object.keys(current)) {
      // Skip OData metadata fields.
      if (key && key.startsWith('@odata.')) continue;
      stack.push(current[key]);
    }
  }

  return false;
}
