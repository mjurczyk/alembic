import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

// NOTE fs.readFile fails above 2 GiB. The file is read in parts into one array.
const partSize = 1 << 30;

export const readFileInParts = (path) => {
  const file = openSync(path, 'r');

  try {
    const { size } = fstatSync(file);
    const bytes = new Uint8Array(size);

    for (let position = 0; position < size; ) {
      const count = readSync(file, bytes, position, Math.min(partSize, size - position), position);

      if (count === 0) {
        throw new Error(`${path} ends at byte ${position}. Its size is ${size} bytes.`);
      }

      position += count;
    }

    return bytes;
  } finally {
    closeSync(file);
  }
};

// NOTE crypto.Hash.update has a size limit. The digest is calculated in parts.
export const getSha256 = (bytes) => {
  const hash = createHash('sha256');

  for (let start = 0; start < bytes.length; start += partSize) {
    hash.update(bytes.subarray(start, start + partSize));
  }

  return hash.digest('hex');
};

const findAbcFiles = (folder) =>
  readdirSync(folder, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(folder, entry.name);

      if (entry.isDirectory()) {
        return findAbcFiles(path);
      }

      return entry.isFile() && extname(entry.name).toLowerCase() === '.abc' ? [path] : [];
    });

// NOTE Each input is a file, or a folder with .abc files (also in sub-folders). "root" keeps the folder structure in the output.
export const findInputs = (inputs) => {
  const tasks = inputs.flatMap((input) => {
    const path = resolve(input);
    const stats = statSync(path, { throwIfNoEntry: false });

    if (!stats) {
      throw new Error(`${input} does not exist.`);
    }

    if (stats.isDirectory()) {
      return findAbcFiles(path).map((file) => ({ path: file, root: path }));
    }

    return [{ path, root: null }];
  });

  // NOTE An input given two times is converted once
  return tasks.filter(({ path }, index) => tasks.findIndex((task) => task.path === path) === index);
};

const toWabcName = (path) => `${basename(path, extname(path))}.wabc`;

// NOTE No output: next to the input. One input file: the output is a file, or a folder if it exists or ends with "/".
// More inputs or a folder: the output is a folder.
const checkUnique = (paths) => {
  const duplicate = paths.find((path, index) => paths.indexOf(path) !== index);

  if (duplicate) {
    throw new Error(`Two inputs give the same output file ${duplicate}. Use other output folders.`);
  }

  return paths;
};

export const getOutputPaths = (tasks, output) => {
  if (!output) {
    return checkUnique(tasks.map(({ path }) => join(dirname(path), toWabcName(path))));
  }

  const outputPath = resolve(output);
  const isFolder =
    tasks.length > 1 ||
    tasks.some(({ root }) => root) ||
    /[\\/]$/.test(output) ||
    statSync(outputPath, { throwIfNoEntry: false })?.isDirectory();

  if (!isFolder) {
    return [outputPath];
  }

  return checkUnique(
    tasks.map(({ path, root }) =>
      join(outputPath, root ? dirname(relative(root, path)) : '', toWabcName(path))
    )
  );
};
