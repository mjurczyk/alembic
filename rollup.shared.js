import { nodeResolve } from '@rollup/plugin-node-resolve';
import uglify from '@lopatnov/rollup-plugin-uglify';
import copy from 'rollup-plugin-copy';
import cleanUpDir from 'rollup-plugin-delete';
import { rollup } from 'rollup';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// NOTE Packages build into build/<name> at the repo root. Rollup runs in the package folder.
export const getOutputDir = (name) => `../../build/${name}`;

// NOTE The built package.json has no scripts, dev dependencies or private flag
const toBuiltPackage = (fields) => (contents) => {
  const packageJson = { ...JSON.parse(contents.toString()), ...fields };

  delete packageJson.private;
  delete packageJson.devDependencies;
  packageJson.scripts = {};

  return `${JSON.stringify(packageJson, null, 2)}\n`;
};

export const copyPackageFiles = (name, fields) =>
  copy({
    targets: [
      { src: './package.json', dest: getOutputDir(name), transform: toBuiltPackage(fields) },
      { src: './README.md', dest: getOutputDir(name) },
    ],
  });

export const cleanOutputDir = (name) => cleanUpDir({ targets: getOutputDir(name), force: true });

// NOTE "./file.js?worker-source" gives file.js and its imports as one script string, for a Blob URL worker. No worker
// file is in the build.
const workerSuffix = '?worker-source';

export const inlineWorker = () => ({
  name: 'inline-worker',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!source.endsWith(workerSuffix) || !importer) {
      return null;
    }

    // NOTE The real path, so a symbolic link (for example /tmp on macOS) gives one module
    const path = realpathSync(resolve(dirname(importer), source.slice(0, -workerSuffix.length)));

    return `\0${path}${workerSuffix}`;
  },
  async load(id) {
    if (!id.startsWith('\0') || !id.endsWith(workerSuffix)) {
      return null;
    }

    const bundle = await rollup({
      input: id.slice(1, -workerSuffix.length),
      plugins: [nodeResolve(), uglify()],
    });
    const { output } = await bundle.generate({ format: 'iife' });

    bundle.watchFiles.forEach((file) => this.addWatchFile(file));
    await bundle.close();

    return `export default ${JSON.stringify(output[0].code)};`;
  },
});

// NOTE ESM and CJS builds of a library package
export const createLibraryConfigs = ({ name, external = [] }) => [
  {
    input: './index.js',
    output: { file: `${getOutputDir(name)}/index.js`, format: 'esm' },
    external,
    plugins: [
      cleanOutputDir(name),
      inlineWorker(),
      nodeResolve(),
      uglify(),
      copyPackageFiles(name, {
        main: './index.cjs.js',
        module: './index.js',
        exports: { '.': { import: './index.js', require: './index.cjs.js' } },
      }),
    ],
  },
  {
    input: './index.js',
    output: { file: `${getOutputDir(name)}/index.cjs.js`, format: 'cjs' },
    external,
    plugins: [inlineWorker(), nodeResolve(), uglify()],
  },
];
