import * as Three from 'three';
import { WabcFile } from 'alembic-web';
import { WABCLoader } from 'three-alembic';
import { getController } from './gui';
import { VolumeSource } from './volumeSource';
import { createVolumeView } from './volumeViews';

// NOTE Volume demos: a .wabc liquid or particles as density grids, made in workers. Same playback members as
// WABCAnimation. Stats show the cost of each step.

const useWebGLRenderer = import.meta.env.VITE_RENDERER === 'webgl';

// NOTE Kept for all volume demos
const params = {
  renderer: 'frame',
  resolution: 128,
  smooth: 1,
  color: '#bfe6ff',
  extinction: 60.0,
  densityScale: 1.0,
  absorbance: 1.0,
  shadowSteps: 16,
  mipmaps: false,
  steps: 64,
  passScale: 0.5,
  lightIntensity: 20.0,
  showSource: false,
};

const stats = {
  statSource: '-',
  statGrid: '-',
  statDecode: '-',
  statBuild: '-',
  statUpdates: '-',
  statWorkers: '-',
};

const setStat = (id, value) => {
  const controller = getController(id);

  stats[id] = value;

  if (controller) {
    controller.object[id] = value;
    controller.updateDisplay();
  }
};

export class VolumeAnimation extends Three.Group {
  isVolumeAnimation = true;
  playing = false;
  loop = true;
  speed = 1.0;
  // NOTE Playback time in frames
  frameTime = 0.0;
  view = null;
  sourceModel = null;
  shownResult = null;
  disposed = false;
  counters = { updates: 0, decodeTime: 0.0, gridTime: 0.0, since: performance.now() };

  // NOTE "context": { scene, camera, renderer, setRenderFrame } of the examples
  constructor(source, bytes, context) {
    super();

    const { kind, path, times } = source.info;

    this.source = source;
    this.bytes = bytes;
    this.context = context;
    this.totalFrames = times.length;
    this.fileFps = times.length > 1 ? (times.length - 1) / (times.at(-1) - times[0]) : 24.0;
    this.label = `${kind} ${path}`;

    setStat('statSource', this.label);
    setStat('statWorkers', `${source.workers.length}`);
    this.createView();
    this.showSourceModel();
  }

  get fps() {
    return this.speed * this.fileFps;
  }

  set fps(fps) {
    this.speed = fps / this.fileFps;
  }

  get frame() {
    return Math.floor(this.frameTime);
  }

  set frame(index) {
    this.frameTime = Three.MathUtils.clamp(Math.round(index), 0, this.totalFrames - 1);
  }

  play() {
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  stop() {
    this.playing = false;
    this.frameTime = 0.0;
  }

  createView() {
    this.view?.dispose();
    this.shownResult = null;
    this.view = createVolumeView(params.renderer, {
      ...this.context,
      resolution: this.source.info.resolution,
      bbox: this.source.info.bbox,
      params,
    });
    this.add(this.view.object);

    const { resolution } = this.source.info;

    setStat('statGrid', `${resolution}³ (${(resolution ** 3 / 1024 / 1024).toFixed(1)} MB)`);
  }

  // NOTE New grid options make all grids again
  applyGridOptions() {
    this.source.setOptions({ resolution: params.resolution, smooth: params.smooth }).then(() => {
      if (!this.disposed) {
        this.createView();
      }
    });
  }

  // NOTE The .wabc model of the same file, at the frame of the volume
  showSourceModel() {
    this.sourceModel?.dispose();
    this.sourceModel?.removeFromParent();
    this.sourceModel = null;

    if (!params.showSource) {
      return;
    }

    new WABCLoader().parse(new WabcFile(this.bytes)).then((model) => {
      if (this.disposed || !params.showSource || this.sourceModel) {
        model.dispose();

        return;
      }

      this.sourceModel = model;
      model.play();
      model.speed = 0.0;
      this.add(model);
    });
  }

  // NOTE Also when paused: a grid that is not ready shows when it is. Until then the last grid stays on screen.
  update(delta) {
    if (this.playing && this.totalFrames > 1) {
      this.frameTime += delta * this.fps;

      if (this.frameTime >= this.totalFrames) {
        if (this.loop) {
          this.frameTime %= this.totalFrames;
        } else {
          this.frameTime = this.totalFrames - 1;
          this.playing = false;
        }
      }
    }

    const { frame, source, counters } = this;
    const result = source.get(frame);

    if (result && result !== this.shownResult && result.resolution === source.info.resolution) {
      this.view.setDensity(result.density);
      this.shownResult = result;
      counters.updates++;
      counters.decodeTime += result.decodeTime;
      counters.gridTime += result.gridTime;
    }

    if (this.sourceModel && this.sourceModel.frame !== frame) {
      this.sourceModel.frame = frame;
      this.sourceModel.update(0.0);
    }

    this.view.update();
    this.updateStats();
  }

  // NOTE Means of the grids shown since the last stats update
  updateStats() {
    const now = performance.now();
    const { counters } = this;
    const elapsed = (now - counters.since) / 1000.0;

    if (elapsed < 0.5) {
      return;
    }

    const { updates, decodeTime, gridTime } = counters;

    setStat('statUpdates', (updates / elapsed).toFixed(1));
    setStat('statDecode', updates ? (decodeTime / updates).toFixed(1) : '-');
    setStat('statBuild', updates ? (gridTime / updates).toFixed(1) : '-');

    if (this.shownResult) {
      const unit = this.source.info.kind === 'points' ? 'points' : 'vertices';

      setStat('statSource', `${this.label} (${this.shownResult.count} ${unit})`);
    }

    Object.assign(counters, { updates: 0, decodeTime: 0.0, gridTime: 0.0, since: now });
  }

  dispose() {
    this.disposed = true;
    this.view?.dispose();
    this.view = null;
    this.sourceModel?.dispose();
    this.sourceModel = null;
    this.source.dispose();
  }
}

export const loadVolumeAnimation = async (bytes, context) => {
  const source = new VolumeSource();

  try {
    await source.open(bytes, { resolution: params.resolution, smooth: params.smooth });
  } catch (error) {
    source.dispose();
    throw error;
  }

  return new VolumeAnimation(source, bytes, context);
};

const getSliderFields = (animation) =>
  [
    ['extinction', 'Extinction', 0.0, 400.0, 1.0],
    ['densityScale', 'Density scale', 0.0, 4.0, 0.01],
    ['absorbance', 'Absorbance', 0.0, 4.0, 0.01],
    ['shadowSteps', 'Shadow steps', 0, 64, 1],
    ['steps', 'Steps (three.js)', 8, 256, 1],
    ...(useWebGLRenderer
      ? []
      : [
          ['passScale', 'Pass scale (three.js)', 0.25, 1.0, 0.05],
          ['lightIntensity', 'Point light (three.js)', 0.0, 200.0, 0.5],
        ]),
  ].map(([id, name, min, max, step]) => ({
    id,
    name,
    defaultValue: params[id],
    min,
    max,
    step,
    onChange: (value) => {
      params[id] = value;
      animation.view?.setParams(params);
    },
  }));

export const getVolumeFields = (animation) => [
  {
    folder: 'Volume',
    children: [
      {
        id: 'renderer',
        name: 'Renderer',
        defaultValue: params.renderer,
        options: {
          'three-openvdb FrameVolume': 'frame',
          [useWebGLRenderer ? 'three.js GLSL ray march' : 'three.js VolumeNodeMaterial']: 'builtin',
        },
        onChange: (value) => {
          params.renderer = value;
          animation.createView();
        },
      },
      ...[
        ['resolution', 'Resolution', 32, 256, 16],
        ['smooth', 'Smooth passes', 0, 3, 1],
      ].map(([id, name, min, max, step]) => ({
        id,
        name,
        defaultValue: params[id],
        min,
        max,
        step,
        onFinishChange: (value) => {
          params[id] = value;
          animation.applyGridOptions();
        },
      })),
      {
        id: 'color',
        name: 'Color',
        defaultValue: params.color,
        options: { Water: '#bfe6ff', White: '#ffffff', Murky: '#7f9f8a' },
        onChange: (value) => {
          params.color = value;
          animation.view?.setParams(params);
        },
      },
      ...getSliderFields(animation),
      {
        id: 'mipmaps',
        name: 'Mipmaps (FrameVolume)',
        defaultValue: params.mipmaps,
        onChange: (value) => {
          params.mipmaps = value;
          animation.view?.setParams(params);
        },
      },
      {
        id: 'showSource',
        name: 'Show .wabc model',
        defaultValue: params.showSource,
        onChange: (value) => {
          params.showSource = value;
          animation.showSourceModel();
        },
      },
    ],
  },
  {
    folder: 'Volume stats',
    children: [
      ['statSource', 'Source'],
      ['statGrid', 'Grid'],
      ['statDecode', 'Decode (ms)'],
      ['statBuild', 'Grid build (ms)'],
      ['statUpdates', 'Grids shown / s'],
      ['statWorkers', 'Workers'],
    ].map(([id, name]) => ({ id, name, defaultValue: stats[id] })),
  },
];
