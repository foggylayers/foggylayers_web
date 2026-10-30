import { defineConfig } from 'astro/config';
import worker from './worker/index.mjs';

export default defineConfig({
  site: 'https://foggylayers.com',
  output: 'static',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  vite: {
    server: { allowedHosts: ['terminal.local'] },
    plugins: [{
      name: 'foggy-layers-local-api',
      configureServer(server) {
        server.middlewares.use('/api/config', async (_req, res) => {
          const response = await worker.fetch(new Request('http://localhost/api/config'), {});
          res.setHeader('Content-Type', 'application/json');
          res.end(await response.text());
        });
      }
    }]
  }
});
