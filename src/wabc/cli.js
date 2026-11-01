import { availableParallelism, endianness } from 'node:os';
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { convertFile } from './convert.js';
import { findInputs, getOutputPaths } from './files.js';

const help = `wabc - converts Alembic (.abc) files into .wabc files (src/wabc/FORMAT.md).

Usage: wabc <input>... [options]

  <input>                      .abc files, or folders with .abc files (sub-folders too)

Options:
  -o, --output <path>          Output file (one input file) or folder. Default: next to each input.
  -b, --bits <16|32>           Positions, uv and widths: 16-bit integers or 32-bit floats. Default: 16.
  -n, --normal-bits <8|16|32>  Normals that the loader cannot calculate: 8-bit or 16-bit integers, or 32-bit
                               floats. Default: 16. Flat and smooth normals are not stored: the loader makes them.
      --surface-bits <0-8>     Meshes made from a grid (for example liquids): only the inside / outside of the grid
                               is stored, and the position on each grid edge with this many bits. The loader makes
                               the triangles. The error is at most 1 / 2^(bits + 1) of a grid cell. 0: off.
                               Default: 3.
      --point-precision <n>    Points with one width: positions on a grid of width / n. The error is at most
                               width / (2 n) on each axis. The point order is not kept. 0: off. Default: 32.
      --objects <paths>        Only these objects (comma-separated full names, for example /Cube/Cube_241),
                               with the objects below them. Default: all objects.
      --samples <first[:last]> Only these samples (indices from 0, "last" included) of the animated object
                               with the most samples. Other objects keep the samples in the same time range.
                               Default: all samples.
  -s, --space <world|local>    Matrices: world matrices, or matrices relative to the parent. Default: world.
  -c, --compression <deflate|brotli>
                               Compression of each chunk. Brotli files are smaller and slower to write.
                               Default: deflate.
  -j, --jobs <n>               Files converted at the same time. Each job keeps one input file in memory.
                               Default: 1.
  -h, --help                   Shows this help.
`;

const options = {
  output: { type: 'string', short: 'o' },
  bits: { type: 'string', short: 'b', default: '16' },
  'normal-bits': { type: 'string', short: 'n', default: '16' },
  'surface-bits': { type: 'string', default: '3' },
  'point-precision': { type: 'string', default: '32' },
  objects: { type: 'string', multiple: true },
  samples: { type: 'string' },
  space: { type: 'string', short: 's', default: 'world' },
  compression: { type: 'string', short: 'c', default: 'deflate' },
  jobs: { type: 'string', short: 'j', default: '1' },
  help: { type: 'boolean', short: 'h' },
};

const fail = (message) => {
  throw Object.assign(new Error(message), { isUsageError: true });
};

const oneOf = (name, value, values) =>
  values.includes(value)
    ? value
    : fail(`--${name} must be ${values.join(' or ')}. It is "${value}".`);

const parsePrecision = (value) => {
  const precision = Number(value);

  if (!Number.isInteger(precision) || precision < 0 || precision > 65536) {
    fail(`--point-precision must be an integer from 0 to 65536. It is "${value}".`);
  }

  return precision;
};

const parseSamples = (value) => {
  if (value === undefined) {
    return null;
  }

  const match = /^(\d+)(?::(\d+))?$/.exec(value);

  if (!match) {
    fail(`--samples must be "first" or "first:last", for example 0:99. It is "${value}".`);
  }

  const first = Number(match[1]);
  const last = match[2] === undefined ? null : Number(match[2]);

  if (last !== null && last < first) {
    fail(`--samples "${value}": last is less than first.`);
  }

  return { first, last };
};

const parseOptions = (args) => {
  let parsed;

  try {
    parsed = parseArgs({ args, options, allowPositionals: true });
  } catch (error) {
    fail(error.message);
  }

  const { values, positionals } = parsed;

  if (values.help) {
    return { help: true };
  }

  if (positionals.length === 0) {
    fail('No input. Give one or more .abc files or folders.');
  }

  const jobs = Number(values.jobs);

  if (!Number.isInteger(jobs) || jobs < 1) {
    fail(`--jobs must be an integer of 1 or more. It is "${values.jobs}".`);
  }

  return {
    inputs: positionals,
    output: values.output ?? null,
    jobs: Math.min(jobs, availableParallelism()),
    convert: {
      bits: Number(oneOf('bits', values.bits, ['16', '32'])),
      normalBits: Number(oneOf('normal-bits', values['normal-bits'], ['8', '16', '32'])),
      surfaceBits: Number(
        oneOf('surface-bits', values['surface-bits'], ['0', '1', '2', '3', '4', '5', '6', '7', '8'])
      ),
      pointPrecision: parsePrecision(values['point-precision']),
      space: oneOf('space', values.space, ['world', 'local']),
      compression: oneOf('compression', values.compression, ['deflate', 'brotli']),
      objects: values.objects
        ? values.objects
            .flatMap((list) => list.split(','))
            .map((path) => path.trim())
            .filter(Boolean)
        : null,
      samples: parseSamples(values.samples),
    },
  };
};

const formatBytes = (bytes) => bytes.toLocaleString('en-US').replaceAll(',', ' ');

const report = ({ inputPath, outputPath, inputBytes, outputBytes, modes, milliseconds }) => {
  const percent = (outputBytes / inputBytes) * 100;
  const share = percent.toFixed(percent < 1 ? 3 : 1);
  const tracks = Object.entries(modes)
    .map(([mode, count]) => `${count} ${mode}`)
    .join(', ');

  console.log(
    `${relative(process.cwd(), inputPath)} -> ${relative(process.cwd(), outputPath)}: ` +
      `${formatBytes(inputBytes)} -> ${formatBytes(outputBytes)} bytes (${share} %), ` +
      `${tracks || 'no geometry'}, ${(milliseconds / 1000).toFixed(1)} s`
  );
};

const show = (result) => (result.error ? console.error(result.error) : report(result.stats));

const convertTask = async ({ input, output }, convertOptions) => {
  try {
    return { stats: await convertFile(input, output, convertOptions) };
  } catch (error) {
    return { error: `${relative(process.cwd(), input)}: ${error.message}` };
  }
};

// NOTE Each worker converts one file at a time. A free worker gets the next file.
const runWorkers = (tasks, jobs, convertOptions) =>
  new Promise((resolve) => {
    const results = [];
    let next = 0;
    let running = jobs;
    const finish = (worker) => {
      worker.terminate();

      if (--running === 0) {
        resolve(results);
      }
    };
    const start = (worker) => {
      if (next >= tasks.length) {
        finish(worker);

        return;
      }

      worker.postMessage({ task: tasks[next++], options: convertOptions });
    };

    for (let job = 0; job < jobs; job++) {
      const worker = new Worker(new URL(import.meta.url));

      worker.on('message', (result) => {
        results.push(result);
        show(result);
        start(worker);
      });
      worker.on('error', (error) => {
        const result = { error: error.message };

        results.push(result);
        show(result);
        finish(worker);
      });
      start(worker);
    }
  });

const main = async () => {
  if (endianness() !== 'LE') {
    throw new Error('wabc needs a little-endian machine.');
  }

  const parsed = parseOptions(process.argv.slice(2));

  if (parsed.help) {
    console.log(help);

    return 0;
  }

  const inputs = findInputs(parsed.inputs);

  if (inputs.length === 0) {
    fail('No .abc files in the input folders.');
  }

  const outputs = getOutputPaths(inputs, parsed.output);
  const tasks = inputs.map(({ path }, index) => ({ input: path, output: outputs[index] }));
  const jobs = Math.min(parsed.jobs, tasks.length);
  let results = [];

  if (jobs > 1) {
    results = await runWorkers(tasks, jobs, parsed.convert);
  } else {
    for (const task of tasks) {
      const result = await convertTask(task, parsed.convert);

      results.push(result);
      show(result);
    }
  }

  return results.some(({ error }) => error) ? 1 : 0;
};

if (isMainThread) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        error.isUsageError ? `${error.message}\n\nUse wabc --help for the options.` : error.message
      );
      process.exitCode = error.isUsageError ? 2 : 1;
    });
} else {
  parentPort.on('message', async ({ task, options: convertOptions }) =>
    parentPort.postMessage(await convertTask(task, convertOptions))
  );
}
