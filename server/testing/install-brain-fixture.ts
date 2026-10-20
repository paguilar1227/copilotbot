export async function installBrainFixture(url: string, endpoint: string): Promise<void> {
  const directory = process.env.OPEN_BRAIN_TEST_PLUGIN;
  if (!directory) throw new Error('Set OPEN_BRAIN_TEST_PLUGIN to the Open Brain repository plugin/copilotbot folder.');
  for (const [path, method, body] of [
    ['/api/plugins/install', 'POST', {directory, trust:true}],
    ['/api/plugins/open-brain-lite/settings', 'PUT', {endpoint}],
    ['/api/plugins/open-brain-lite/enable', 'PUT', {enabled:true}],
  ] as const) {
    const response = await fetch(url + path, {method, headers:{'Content-Type':'application/json',origin:url},body:JSON.stringify(body)});
    if (!response.ok) throw new Error('Fixture plugin installation failed: ' + await response.text());
  }
}
