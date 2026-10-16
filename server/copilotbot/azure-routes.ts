import { PASS, type RouteHandler } from '../routes/table.ts';
import type { AzureConfig } from '../../shared/copilotbot.ts';
import { azureDeployments, runAzure } from './azure-auth.ts';

export function azureRoutes(config: () => AzureConfig): RouteHandler {
  return async ({ path, method, res, json }) => {
    if (method !== 'GET' || !path.startsWith('/api/copilotbot/azure/')) return PASS;
    try {
      if (path === '/api/copilotbot/azure/deployments') return json(res, 200, { deployments: await azureDeployments(config()) });
      if (path === '/api/copilotbot/azure/resources') {
        const args = ['cognitiveservices', 'account', 'list', '--output', 'json'];
        if (config().subscription) args.push('--subscription', config().subscription!);
        const rows = JSON.parse(await runAzure(args)) as Array<{ name: string; resourceGroup: string; kind: string; properties?: { endpoint?: string } }>;
        return json(res, 200, { resources: rows.filter(row => ['OpenAI', 'AIServices'].includes(row.kind)).map(row => ({ name: row.name, resourceGroup: row.resourceGroup, endpoint: row.properties?.endpoint })) });
      }
    } catch (error) { return json(res, 400, { error: (error as Error).message }); }
    return PASS;
  };
}
