import { nodeResolve } from '@rollup/plugin-node-resolve';
import { cleanOutputDir, copyPackageFiles, getOutputDir } from '../../rollup.shared.js';

// NOTE One file with alembic inside. It needs only Node.
export default {
  input: './cli.js',
  output: {
    file: `${getOutputDir('wabc')}/cli.mjs`,
    format: 'esm',
    banner: '#!/usr/bin/env node',
  },
  external: [/^node:/],
  plugins: [
    cleanOutputDir('wabc'),
    nodeResolve(),
    copyPackageFiles('wabc', { bin: { wabc: './cli.mjs' }, dependencies: {} }),
  ],
};
