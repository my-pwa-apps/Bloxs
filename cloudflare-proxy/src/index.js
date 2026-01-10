/**
 * Bloxs OData Proxy for Cloudflare Workers
 * 
 * This worker handles JWT token management for the Bloxs API,
 * allowing Copilot to authenticate with a short API key.
 * 
 * Features:
 * - Automatic JWT token refresh
 * - Schema/metadata caching for field validation
 * - Intelligent error handling with field suggestions
 */

// Token cache (in-memory, per worker instance)
let cachedToken = null;
let tokenExpiry = 0;

// Schema cache for entity metadata
let schemaCache = {};
let schemaCacheExpiry = 0;

// Known sortable fields per entity (fallback if metadata unavailable)
const KNOWN_SORTABLE_FIELDS = {
  'ServiceTickets': ['ServiceTicketId', 'Reference', 'ReportingDate', 'ClosingDate', 'Priority', 'RealEstateObjectName'],
  'Units': ['UnitId', 'DisplayName', 'Reference', 'CategoryName', 'OccupationPercentage', 'Owner'],
  'SalesContracts': ['SalesContractId', 'Reference', 'StartDate', 'EndDate', 'RelationName', 'OwnerName'],
  'Relations': ['RelationId', 'DisplayName', 'Reference'],
  'Persons': ['PersonId', 'DisplayName', 'FirstName', 'LastName'],
  'Notes': ['NoteId', 'CreatedOnTimeStamp', 'LastEditedOnTimeStamp', 'EntityLinkType'],
  'OpenPositionDebtors': ['SalesInvoiceId', 'InvoiceDate', 'DueDate', 'Age', 'OutstandingAmount', 'RelationName'],
  'OpenPositionCreditors': ['PurchaseInvoiceId', 'InvoiceDate', 'DueDate', 'Age', 'OutstandingAmount', 'RelationName'],
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
    const fieldName = orderBy.split(' ')[0]; // Extract field name (before 'asc'/'desc')
    const knownFields = KNOWN_SORTABLE_FIELDS[entityName] || KNOWN_SORTABLE_FIELDS['default'];
    
    if (!knownFields.includes(fieldName)) {
      // Try to find a similar field or use a safe default
      const safeField = findSafeOrderByField(entityName);
      if (safeField) {
        const direction = orderBy.includes('desc') ? ' desc' : '';
        params.set('$orderby', safeField + direction);
        console.log(`Fixed $orderby: ${orderBy} -> ${safeField}${direction}`);
      } else {
        // Remove invalid orderby entirely
        params.delete('$orderby');
        console.log(`Removed invalid $orderby: ${orderBy}`);
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
    entities: {
      Units: {
        description: 'Rental units (apartments, offices, retail spaces)',
        sortableFields: KNOWN_SORTABLE_FIELDS['Units'],
        filterExamples: ["OccupationPercentage lt 1", "CategoryName eq 'Winkelruimte'"]
      },
      SalesContracts: {
        description: 'Rent contracts with tenants',
        sortableFields: KNOWN_SORTABLE_FIELDS['SalesContracts'],
        filterExamples: ["IsEnded eq false", "EndDate lt 2026-06-01"]
      },
      ServiceTickets: {
        description: 'Maintenance service tickets',
        sortableFields: KNOWN_SORTABLE_FIELDS['ServiceTickets'],
        filterExamples: ["ServiceTicketStateName ne 'Afgerond'", "Priority eq 'High'"]
      },
      Relations: {
        description: 'Tenants, contacts, suppliers',
        sortableFields: KNOWN_SORTABLE_FIELDS['Relations'],
        filterExamples: ["contains(DisplayName, 'BV')"]
      },
      OpenPositionDebtors: {
        description: 'Outstanding receivables (debtor aging)',
        sortableFields: KNOWN_SORTABLE_FIELDS['OpenPositionDebtors'],
        filterExamples: ["Age gt 90", "OutstandingAmount gt 1000"]
      },
      Notes: {
        description: 'Notes attached to entities',
        sortableFields: KNOWN_SORTABLE_FIELDS['Notes'],
        filterExamples: ["EntityLinkType eq 'Person'", "EntityId eq 123"]
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
