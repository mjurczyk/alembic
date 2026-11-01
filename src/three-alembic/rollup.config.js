import { nodeResolve } from '@rollup/plugin-node-resolve';
import uglify from '@lopatnov/rollup-plugin-uglify';
import { createLibraryConfigs, getOutputDir } from '../../rollup.shared.js';

export default [
  ...createLibraryConfigs({
    name: 'three-alembic',
    external: ['three', /^three\//, 'alembic'],
  }),
  // NOTE The .wabc worker is its own file next to index.js (new URL('./wabcWorker.js', import.meta.url)), with alembic in it
  {
    input: './wabc/wabcWorker.js',
    output: { file: `${getOutputDir('three-alembic')}/wabcWorker.js`, format: 'esm' },
    plugins: [nodeResolve(), uglify()],
  },
];
