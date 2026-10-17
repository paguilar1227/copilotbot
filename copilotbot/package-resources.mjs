import { join } from 'node:path';

export function reusedDuckdbResource(resources) {
  return { from: join(resources, 'duckdb', 'node_modules'), to: 'duckdb/node_modules' };
}
