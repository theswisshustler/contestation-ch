import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  site: 'https://contestation.ch',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  publicDir: './web',
  build: {
    assets: '_assets',
  },
  server: {
    host: true,
    port: 5000,
  },
});
