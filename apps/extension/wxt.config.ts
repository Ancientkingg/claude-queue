import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Claude Queue',
    description: 'Schedule and queue messages for Claude.ai',
    permissions: ['cookies', 'storage', 'activeTab'],
    host_permissions: ['https://claude.ai/*'],
    incognito: 'spanning',
  },
  webExt: {
    startUrls: ['https://claude.ai'],
  },
});
