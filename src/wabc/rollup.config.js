import { nodeResolve } from '@rollup/plugin-node-resolve';
import { cleanOutputDir, copyPackageFiles, getOutputDir } from '../../rollup.shared.js';

// NOTE One file with alembic-web inside. It needs only Node.
export default {
  input: './cli.js',
  output: {
    file: `${getOutputDir('webabc')}/cli.mjs`,
    format: 'esm',
    banner: '#!/usr/bin/env node',
  },
  external: [/^node:/],
  plugins: [
    cleanOutputDir('webabc'),
    nodeResolve(),
    copyPackageFiles('webabc', { bin: { wabc: 'cli.mjs' }, dependencies: {} }),
  ],
};
