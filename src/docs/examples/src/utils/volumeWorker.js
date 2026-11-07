import { WabcFile } from 'alembic-web';
import {
  getCoarseGrid,
  getPointsBox,
  getSurfaceLayout,
  pointsToDensity,
  smoothDensity,
  surfaceToDensity,
} from './volumeGrids.js';

// NOTE Worker of VolumeSource: grids of the first surface mesh or points track.
// Jobs run in order, because surface samples are decoded in order.

// NOTE Nodes in a block of a surface chunk (wabc FORMAT.md 4.5)
const surfaceBlockSize = 8;

// NOTE Samples of a points track read to find its box
const boxSamples = 16;

let context = null;
let queue = Promise.resolve();

// NOTE "box": the box of a points track, found by an other worker. Without it, the box is found here.
const open = async ({ bytes, resolution, box }) => {
  const file = new WabcFile(bytes);
  const node = file.nodes.findIndex(
    ({ type, geometry }) => type === 'points' || (type === 'mesh' && geometry?.mode === 'surface')
  );

  if (node < 0) {
    throw new Error('The file has no points and no mesh made from a grid.');
  }

  const track = file.getGeometry(node);
  const kind = file.nodes[node].type === 'points' ? 'points' : 'surface';
  const times = Array.from({ length: track.numSamples }, (_, sample) =>
    track.getSampleTime(sample)
  );

  context = { file, track, kind, layout: null, box: null, resolution: 0 };

  if (kind === 'points' && box) {
    context.box = box;
  } else if (kind === 'points') {
    const step = Math.max(Math.floor(track.numSamples / boxSamples), 1);
    const samples = [];

    for (let sample = 0; sample < track.numSamples; sample += step) {
      samples.push((await track.readSample(sample)).position);
    }

    samples.push((await track.readSample(track.numSamples - 1)).position);
    context.box = getPointsBox(samples, track.track.width);
  }

  const layout = configure(resolution);

  return { kind, path: file.nodes[node].path, times, ...layout };
};

// NOTE A surface grid is not made larger than its node count
const configure = (resolution) => {
  const { kind, track } = context;

  if (kind === 'surface') {
    context.layout = getSurfaceLayout(track.track, resolution);
    context.resolution = context.layout.resolution;

    return { resolution: context.resolution, bbox: context.layout.bbox };
  }

  context.resolution = resolution;

  return { resolution, bbox: context.box };
};

const readSample = async ({ sample, smooth }) => {
  const { kind, track, layout, box, resolution } = context;
  const decodeStart = performance.now();
  let decoded;
  let position;

  if (kind === 'surface') {
    decoded = await track.decodeSurface(sample);
  } else {
    position = (await track.readSample(sample)).position;
  }

  const gridStart = performance.now();
  const density = smoothDensity(
    kind === 'surface'
      ? surfaceToDensity(decoded, surfaceBlockSize, layout)
      : pointsToDensity(position, track.track.width, box, resolution),
    resolution,
    smooth
  );
  const coarse = getCoarseGrid(density, resolution);
  const end = performance.now();

  return {
    sample,
    resolution,
    density,
    coarse,
    count: kind === 'surface' ? decoded.edges.length : position.length / 3,
    decodeTime: gridStart - decodeStart,
    gridTime: end - gridStart,
  };
};

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      if (data.type === 'open') {
        self.postMessage({ id: data.id, result: await open(data) });
      } else if (data.type === 'configure') {
        self.postMessage({ id: data.id, result: configure(data.resolution) });
      } else {
        const result = await readSample(data);

        self.postMessage({ id: data.id, result }, [result.density.buffer, result.coarse.buffer]);
      }
    } catch (error) {
      self.postMessage({ id: data.id, error: error.message });
    }
  });
};
