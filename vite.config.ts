import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './routes',
      generatedRouteTree: './routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.VITE_PORT ?? '5173'),
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.PORT ?? '3001'}`,
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
