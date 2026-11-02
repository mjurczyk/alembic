import { defineConfig } from 'vite';
import { inlineWorker } from '../../../rollup.shared.js';

// NOTE GitHub Pages serves the examples at https://mjurczyk.github.io/alembic/
export default defineConfig({
  base: '/alembic/',
  plugins: [inlineWorker()],
});
