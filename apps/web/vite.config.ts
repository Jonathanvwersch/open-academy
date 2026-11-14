import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.VITE_PORT ?? '5173'),
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? '3001'}`,
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
