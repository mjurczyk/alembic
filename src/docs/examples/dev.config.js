import { defineConfig } from 'vite';
import { inlineWorker } from '../../../rollup.shared.js';

export default defineConfig({
  plugins: [inlineWorker()],
});
