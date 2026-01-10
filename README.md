# Bloxs Real Estate Copilot Agent

A Microsoft 365 Copilot declarative agent that connects to Bloxs real estate management software.

## Overview

This agent enables users to interact with their Bloxs real estate data directly through Microsoft 365 Copilot. Users can query properties, tenants, contracts, maintenance tickets, and financial information using natural language.

## Features

The agent supports the following capabilities:

### 📍 Property Management
- Query buildings, complexes, sections, and rental units
- Find vacant units
- Get property details and metrics

### 👥 Relationship Management
- Search for tenants (persons and organisations)
- Look up property owners
- Find suppliers and estate agents
- Get contact information

### 📄 Contract Management
- Retrieve commercial rent contracts
- Access private rent contracts
- View supplier contracts
- Filter contracts by status or expiration date

### 🔧 Maintenance
- View service tickets
- Filter by status (open, in progress, completed)
- Create new maintenance requests
- Track repair progress

### 💰 Financial
- Access invoice journals
- View financial entries

## Project Structure

```
Bloxs/
├── appPackage/
│   ├── manifest.json           # Teams app manifest
│   ├── declarativeAgent.json   # Copilot agent definition
│   ├── ai-plugin.json          # API plugin configuration
│   ├── bloxs-openapi.yaml      # OpenAPI specification for Bloxs API
│   ├── color.png               # App icon (color)
│   └── outline.png             # App icon (outline)
├── env/
│   ├── .env.dev                # Development environment variables
│   └── .env.dev.user           # User-specific dev variables
├── teamsapp.yml                # Teams Toolkit configuration
├── teamsapp.local.yml          # Local debug configuration
├── package.json
└── README.md
```

## Prerequisites

1. **Microsoft 365 Developer Account** with Copilot license
2. **Teams Toolkit** extension for VS Code (v5.0+)
3. **Node.js** 18.0 or higher
4. **Bloxs API Credentials**:
   - API Key (belongs to a user in Bloxs)
   - API Secret (belongs to your Bloxs client application)

## Setup

### 1. Clone and Install

```bash
git clone <repository-url>
cd Bloxs
npm install
```

### 2. Configure API Credentials

Create/edit `env/.env.dev.user` and add your Bloxs API credentials:

```env
SECRET_BLOXS_API_KEY=your-api-key-here
SECRET_BLOXS_API_SECRET=your-api-secret-here
```

### 3. Update API Base URL

If your Bloxs instance uses a different API URL, update it in `appPackage/bloxs-openapi.yaml`:

```yaml
servers:
  - url: https://your-bloxs-instance.bloxs.com/api/v1
```

### 4. Add App Icons

Add two icon files to the `appPackage` folder:
- `color.png` - 192x192 pixel color icon
- `outline.png` - 32x32 pixel outline icon (transparent background)

## Deployment

### Using Teams Toolkit

1. Open the project in VS Code
2. Sign in to your Microsoft 365 account via Teams Toolkit
3. Press `F5` to debug locally, or
4. Use the Teams Toolkit sidebar to provision and deploy:
   - Click "Provision" to create Azure resources
   - Click "Deploy" to upload the agent
   - Click "Publish" to make it available in your organization

### Manual Deployment

1. Package the app:
   ```bash
   # Zip the contents of appPackage folder
   ```

2. Upload to Teams Admin Center or Microsoft 365 Admin Center

3. Configure API key authentication in the Microsoft 365 Admin Center

## Authentication

The agent uses API Key authentication to connect to Bloxs. The authentication flow:

1. User invokes the agent in Copilot
2. Agent calls Bloxs API with the configured API key
3. API returns requested data
4. Agent formats and presents the information

**Note**: The API key is stored securely in the Microsoft 365 Plugin Vault and referenced via `BLOXS_API_KEY_REFERENCE` in the environment configuration.

## Usage Examples

Once deployed, users can interact with the agent in Microsoft 365 Copilot:

- *"Show me an overview of our real estate portfolio"*
- *"Find all vacant rental units"*
- *"What maintenance tickets are open?"*
- *"Get the contract details for tenant ABC Company"*
- *"List all suppliers we work with"*
- *"Show contracts expiring in the next 3 months"*
- *"Create a maintenance ticket for broken heating in unit 123"*

## API Documentation

This agent connects to the Bloxs Open API. For detailed API documentation, visit:
- [Bloxs API Documentation](https://www.bloxs.io/apidocs/welcome)

### Available API Modules

| Module | Description |
|--------|-------------|
| Relations | Manage tenants, owners, suppliers, estate agents |
| RealEstateObjects | Buildings, complexes, sections, units |
| Contracts | Commercial and private rent contracts |
| Maintenance | Service tickets for repairs |
| Invoices | Financial journals and entries |

## Troubleshooting

### Agent not responding
- Verify your Bloxs API credentials are correct
- Check that the API base URL is accessible
- Ensure you have a valid Copilot license

### Authentication errors
- Regenerate your API key in Bloxs
- Update the key in your environment configuration
- Re-deploy the agent

### Data not appearing
- Verify you have access to the requested data in Bloxs
- Check API permissions for your user account
- Review the Bloxs API documentation for required parameters

## Support

- **Bloxs Support**: support@bloxs.com
- **Bloxs Website**: https://www.bloxs.com
- **API Documentation**: https://www.bloxs.io

## License

MIT License - See LICENSE file for details.
