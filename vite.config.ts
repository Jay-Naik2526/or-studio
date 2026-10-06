import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  // pre-bundle every heavy dependency up front so the dev server never re-optimises mid-session (which breaks open pages)
  optimizeDeps: { include: ['recharts', 'katex', 'html-to-image', 'lz-string', 'lucide-react', 'framer-motion', 'd3', 'zod', 'zustand'] },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
