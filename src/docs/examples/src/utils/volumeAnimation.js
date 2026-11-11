import * as Three from 'three';
import { WabcFile } from 'alembic-web';
import { WABCLoader } from 'three-alembic';
import { createLiquidWebGLView } from './volumeLiquidWebGL';
import { createLiquidWebGPUView } from './volumeLiquidWebGPU';
import { VolumeSource } from './volumeSource';

// NOTE Liquid demos: a .wabc liquid or particles as density grids, made in workers, shown as a liquid.
// NOTE Same playback members as WABCAnimation.

const createLiquidView =
  import.meta.env.VITE_RENDERER === 'webgl' ? createLiquidWebGLView : createLiquidWebGPUView;

// NOTE Values of the liquid view. Each demo starts from defaultParams and its own settings.
const params = {
  resolution: 100,
  smooth: 2,
  // NOTE Color of the light after "tintDistance" world units in the liquid
  color: '#bfe6ff',
  tintDistance: 1.0,
  // NOTE Density of the surface
  surfaceLevel: 0.5,
  ior: 1.333,
  scatter: 0.1,
  showSource: false,
};

const defaultParams = { ...params };

class VolumeAnimation extends Three.Group {
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

  // NOTE "context": { scene, camera, renderer, setRenderFrame } of the examples
  constructor(source, bytes, context) {
    super();

    const { times } = source.info;

    this.source = source;
    this.bytes = bytes;
    this.context = context;
    this.totalFrames = times.length;
    this.fileFps = times.length > 1 ? (times.length - 1) / (times.at(-1) - times[0]) : 24.0;
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
    this.view = createLiquidView({
      ...this.context,
      resolution: this.source.info.resolution,
      bbox: this.source.info.bbox,
      params,
    });
    this.add(this.view.object);
  }

  // NOTE New grid options make all grids again
  applyGridOptions() {
    this.source.setOptions({ resolution: params.resolution, smooth: params.smooth }).then(() => {
      if (!this.disposed) {
        this.createView();
      }
    });
  }

  // NOTE The .wabc model of the same file, at the frame of the liquid
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

    const { frame, source } = this;
    const result = source.get(frame);

    if (result && result !== this.shownResult && result.resolution === source.info.resolution) {
      this.view.setDensity(result.density, result.coarse);
      this.shownResult = result;
    }

    if (this.sourceModel && this.sourceModel.frame !== frame) {
      this.sourceModel.frame = frame;
      this.sourceModel.update(0.0);
    }

    this.view.update();
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

// NOTE "settings": values of "params" for this demo, for example { surfaceLevel: 0.25 }
export const loadVolumeAnimation = async (bytes, context, settings = {}) => {
  const source = new VolumeSource();

  Object.assign(params, defaultParams, settings);

  try {
    await source.open(bytes, { resolution: params.resolution, smooth: params.smooth });
  } catch (error) {
    source.dispose();
    throw error;
  }

  return new VolumeAnimation(source, bytes, context);
};

export const getVolumeFields = (animation) => {
  const setParam = (id, value) => {
    params[id] = value;
    animation.view?.setParams(params);
  };

  return [
    {
      folder: 'Liquid',
      children: [
        ...[
          ['resolution', 'Resolution', 32, 256, 4],
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
          name: 'Tint',
          defaultValue: params.color,
          options: { Water: '#bfe6ff', White: '#ffffff', Murky: '#7f9f8a' },
          onChange: (value) => setParam('color', value),
        },
        ...[
          ['tintDistance', 'Tint distance', 0.05, 10.0, 0.05],
          ['surfaceLevel', 'Surface level', 0.05, 0.95, 0.01],
          ['ior', 'IOR', 1.0, 2.0, 0.001],
          ['scatter', 'Murk', 0.0, 1.0, 0.01],
        ].map(([id, name, min, max, step]) => ({
          id,
          name,
          defaultValue: params[id],
          min,
          max,
          step,
          onChange: (value) => setParam(id, value),
        })),
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
  ];
};
