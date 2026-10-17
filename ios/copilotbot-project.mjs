// Generates the downstream Xcode spec without changing the recovered upstream spec.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
const root = dirname(fileURLToPath(import.meta.url));
const project = parse(readFileSync(join(root, 'project.yml'), 'utf8'));
const group = 'group.com.copilotbot.shared';
for (const [name, target] of Object.entries(project.targets)) {
  for (const source of target.sources ?? []) {
    if (typeof source === 'object') source.excludes = [...(source.excludes ?? []), 'Info.plist', '*.entitlements'];
  }
  if (target.settings?.base?.MARKETING_VERSION) {
    target.settings.base.MARKETING_VERSION = '1.0.0';
    target.settings.base.CURRENT_PROJECT_VERSION = '1';
  }
  if (target.settings?.base?.PRODUCT_BUNDLE_IDENTIFIER) {
    target.settings.base.PRODUCT_BUNDLE_IDENTIFIER = target.settings.base.PRODUCT_BUNDLE_IDENTIFIER.replace('com.openmausbot.app', 'com.copilotbot.app');
  }
  if (target.entitlements) {
    target.entitlements.path = `.copilotbot-build/${name}.entitlements`;
    target.entitlements.properties['com.apple.security.application-groups'] = [group];
    target.entitlements.properties['keychain-access-groups'] = name === 'OpenMausCompanion'
      ? ['$(AppIdentifierPrefix)com.copilotbot.app', `$(AppIdentifierPrefix)${group}`]
      : [`$(AppIdentifierPrefix)${group}`];
  }
  target.info ??= { properties: {} };
  target.info.path = `.copilotbot-build/${name}-Info.plist`;
  Object.assign(target.info.properties, {
    CFBundleDisplayName: 'CopilotBot',
    CopilotBotAppBundleID: 'com.copilotbot.app',
    CopilotBotURLScheme: 'copilotbot',
    CopilotBotAppGroup: group,
    CopilotBotKeychainService: 'com.copilotbot.companion.token',
  });
  if (name !== 'OpenMausCompanionUITests') target.info.properties.OpenMausKeychainAccessGroup = `$(AppIdentifierPrefix)${group}`;
  if (name === 'OpenMausCompanion') {
    target.info.properties.CFBundleURLTypes = [{ CFBundleURLName: 'com.copilotbot.companion.pairing', CFBundleURLSchemes: ['copilotbot'] }];
    for (const key of ['NSLocalNetworkUsageDescription', 'NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']) {
      target.info.properties[key] = target.info.properties[key].replaceAll('OpenMausBot', 'CopilotBot').replaceAll('OpenMausMobile', 'CopilotBot');
    }
  }
}
writeFileSync(join(root, '.copilotbot-project.yml'), stringify(project));
