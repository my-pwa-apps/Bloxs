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

// Known sortable fields per entity (fallback if metadata unavailable)
const KNOWN_SORTABLE_FIELDS = {
  'ServiceTickets': ['ServiceTicketId', 'Reference', 'ReportingDate', 'ClosingDate', 'Priority', 'RealEstateObjectName', 'TenantName', 'SupplierName'],
  'ServiceTicketStates': ['ServiceTicketStateId', 'Name'],
  'Units': ['UnitId', 'DisplayName', 'Reference', 'CategoryName', 'OccupationPercentage', 'Owner', 'OwnerId'],
  'SalesContracts': ['SalesContractId', 'Reference', 'StartDate', 'EndDate', 'RelationName', 'OwnerName'],
  'SalesContractRealestateObjects': ['SalesContractId', 'RealEstateObjectId', 'SortingIndex'],
  'FinancingContracts': ['FinancingContractId', 'Reference', 'StartDate', 'EndDate', 'PrincipalAmount', 'RealEstateObjectId'],
  'FinancialMutations': ['JournalPostId', 'TransactionDate', 'LedgerAccountCode', 'Amount', 'RealEstateObjectName', 'RelationName', 'FinancialYear'],
  'LedgerAccounts': ['LedgerAccountId', 'Code', 'Name', 'LedgerAccountType'],
  'Relations': ['RelationId', 'DisplayName', 'Reference'],
  'Persons': ['PersonId', 'RelationId', 'DisplayName', 'FirstName', 'LastName', 'Email'],
  'Owners': ['OwnerId', 'RelationId', 'DisplayName', 'Reference', 'State', 'Email'],
  'Complexes': ['ComplexId', 'RealEstateObjectId', 'Reference', 'DisplayName', 'Owner', 'OccupationPercentage'],
  'SalesInvoices': ['SalesInvoiceId', 'Reference', 'InvoiceDate', 'DueDate', 'WorkflowState', 'TotalValueIncluding', 'OwnerName', 'RelationName'],
  'OwnerSettlements': ['OwnerSettlementId', 'Reference', 'PeriodStart', 'PeriodEnd', 'OwnerName', 'TotalSettlementBalance'],
  'Tasks': ['TaskId', 'Status', 'Deadline', 'ShowFromDate', 'TaskCategory'],
  'Addresses': ['AddressId', 'Street', 'City', 'PostalCode'],
  'Meters': ['MeterId', 'RealEstateObjectId', 'CategoryName', 'EANCode'],
  'MeterReadings': ['MeterReadingId', 'MeterId', 'ReadingDate', 'ReadingValue'],
  'IndexationMethods': ['IndexationMethodId', 'Name', 'Type'],
  'CommercialOverview': ['RealEstateObjectId', 'Address', 'OwnerName', 'TenantName', 'IsOccupied'],
  'PropertyValuationValues': ['PropertyValuationValueId', 'RealEstateObjectId', 'ValuationYear', 'Value'],
  'Notes': ['NoteId', 'CreatedOnTimeStamp', 'LastEditedOnTimeStamp', 'EntityLinkType', 'EntityId'],
  'OpenPositionDebtors': ['SalesInvoiceId', 'InvoiceDate', 'DueDate', 'Age', 'OutstandingAmount', 'RelationName'],
  'OpenPositionCreditors': ['PurchaseInvoiceId', 'InvoiceDate', 'DueDate', 'Age', 'OutstandingAmount', 'RelationName'],
  'TheoreticalRentItems': ['TheoreticalRentItemId', 'RealEstateObjectId', 'RealEstateObjectName', 'Amount', 'StartDate', 'EndDate'],
  'PurchaseOrders': ['PurchaseOrderId', 'Reference', 'OrderDate', 'RelationName', 'TotalAmount', 'WorkflowState'],
  'Installations': ['InstallationId', 'RealEstateObjectId', 'Name', 'InstallationTypeName', 'NextMaintenanceOn'],
  'Projects': ['ProjectId', 'Reference', 'Name', 'StartDate', 'EndDate', 'Status'],
  'Buildings': ['BuildingId', 'RealEstateObjectId', 'Reference', 'DisplayName', 'DisplayAddress', 'OwnerId', 'Owner', 'CategoryName'],
  'SalesContractLineItems': ['SalesContractLineItemId', 'SalesContractId', 'RealEstateObjectId', 'RealEstateObjectName', 'Amount', 'StartDate', 'EndDate', 'LedgerAccountName'],
  'PurchaseInvoices': ['PurchaseInvoiceId', 'Reference', 'InvoiceDate', 'DueDate', 'WorkflowState', 'TotalValueIncluding', 'RelationName', 'RealEstateObjectName', 'FinancialYear'],
  'PurchaseInvoiceLines': ['PurchaseInvoiceLineId', 'PurchaseInvoiceId', 'RealEstateObjectId', 'RealEstateObjectName', 'Amount', 'LedgerAccountName'],
  'RealEstateObjects': ['RealEstateObjectId', 'Reference', 'DisplayName', 'DisplayAddress', 'CategoryName'],
  'default': ['Id', 'Reference', 'DisplayName', 'Name']
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    // Special endpoint: Get available entities and their fields
    if (url.pathname === '/odatafeed/$metadata-summary') {
      return handleMetadataSummary(env);
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

    // Get or refresh the Bloxs JWT token
    let token;
    try {
      token = await getBloxsToken(env);
    } catch (error) {
      return jsonError(`Failed to get Bloxs token: ${error.message}`, 500);
    }

    // Extract entity name from path for validation
    const pathMatch = url.pathname.match(/\/odatafeed\/([^/?]+)/);
    const entityName = pathMatch ? pathMatch[1] : null;

    // Validate and fix query parameters if needed
    const fixedSearch = await validateAndFixQuery(url.search, entityName, env, token);
    
    // Forward the request to Bloxs OData API
    const bloxsUrl = `${env.BLOXS_BASE_URL}${url.pathname}${fixedSearch}`;
    
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

      return new Response(responseBody, {
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
async function validateAndFixQuery(search, entityName, env, token) {
  if (!search || !entityName) return search;
  
  const params = new URLSearchParams(search);
  const orderBy = params.get('$orderby');
  
  // If there's an $orderby, validate the field exists
  if (orderBy) {
    const knownFields = KNOWN_SORTABLE_FIELDS[entityName] || KNOWN_SORTABLE_FIELDS['default'];

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

      if (fieldName && knownFields.includes(fieldName)) {
        normalizedSegments.push(direction === 'desc' ? `${fieldName} desc` : fieldName);
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

/**
 * Find a safe default field for ordering
 */
function findSafeOrderByField(entityName) {
  const knownFields = KNOWN_SORTABLE_FIELDS[entityName];
  if (knownFields && knownFields.length > 0) {
    // Prefer Id or Reference fields for stable sorting
    const preferred = knownFields.find(f => f.endsWith('Id') || f === 'Reference');
    return preferred || knownFields[0];
  }
  return null;
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
    helpfulError.availableFields = KNOWN_SORTABLE_FIELDS[entityName] || KNOWN_SORTABLE_FIELDS['default'];
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
        filterExamples: ["IsOccupied eq true", "IsOccupied eq false"],
        note: 'Excellent for quick portfolio overview without complex joins'
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
  
  // Parse expiration date and convert to timestamp
  // Bloxs returns format like "01/10/2026 16:42:26"
  const expirationDate = new Date(data.expiration);
  tokenExpiry = expirationDate.getTime();

  return cachedToken;
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
