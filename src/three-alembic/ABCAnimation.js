import * as Three from 'three';
import { getAnimationBackend } from './animation/core/animationBackend.js';
import { blendMatrices } from './animation/core/blendMatrices.js';
import { VertexAnimation, canUseVertexAnimation } from './animation/core/VertexAnimation.js';
import { createPointsGeometry } from './geometry/PointsGeometry.js';
import { createPolyMeshGeometry, createPolyMeshLayout } from './geometry/PolyMeshGeometry.js';
import { runProgressive } from './scene/progressive.js';
import { applyMatrices, applyUpdates, buildUpdates, disposeUpdates } from './scene/sceneNodes.js';

// NOTE Fallback frames built before they are shown
const lookaheadFrames = 2;

const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

const getBlend = ({ timeSampling, numSamples }, time) => timeSampling.getBlend(time, numSamples);

// NOTE 'static': one sample. 'xform': CPU blend. 'vertex': GPU blend (VertexAnimation). 'swap': a new geometry for each sample.
const getMode = ({ animated, object }) => {
  const { schema } = object;

  if (!animated) {
    return 'static';
  }

  if (schema.type === 'Xform') {
    return 'xform';
  }

  return canUseVertexAnimation(schema) ? 'vertex' : 'swap';
};

// NOTE Root node of an animated file, as FrameVolumeAnimation of three-openvdb. "time" is in seconds. Each object uses its own time sampling.
export class ABCAnimation extends Three.Group {
  isABCAnimation = true;

  // NOTE Playback speed. 1 is real time, negative values play backwards.
  speed = 1.0;
  loop = true;
  playing = false;
  disposed = false;
  currentTime = 0.0;

  // NOTE One progressive task at a time (see runProgressive)
  task = null;
  job = null;
  // NOTE Built fallback frames that are not on screen. Key: the sample index of each 'swap' entry.
  fallbackFrames = new Map();
  fallbackWindow = [];
  shownFallbackKey = null;

  constructor(entries, { numSamples, timeSampling, startTime, endTime }) {
    super();

    this.entries = entries;
    this.totalFrames = numSamples;
    this.timeSampling = timeSampling;
    this.startTime = startTime;
    this.endTime = endTime;

    entries.forEach((entry) => {
      entry.mode = getMode(entry);
      entry.vertexAnimation = null;
    });

    // NOTE The frame rate of the file. Average for cyclic and acyclic time samplings.
    const lastFrame = timeSampling.getLastIndex(numSamples);
    const duration = timeSampling.getSampleTime(lastFrame) - timeSampling.getSampleTime(0);

    this.fileFps = duration > 0 ? lastFrame / duration : 24.0;
  }

  get time() {
    return this.currentTime;
  }

  set time(time) {
    this.currentTime = Three.MathUtils.clamp(time, this.startTime, this.endTime);
    this.applyTime();
  }

  // NOTE Frame of the time: the last sample of the timeline at or before it
  get frame() {
    return this.timeSampling.getSampleIndex(this.currentTime, this.totalFrames);
  }

  set frame(index) {
    const lastFrame = this.timeSampling.getLastIndex(this.totalFrames);

    this.time = this.timeSampling.getSampleTime(
      Three.MathUtils.clamp(Math.round(index), 0, lastFrame)
    );
  }

  // NOTE Frames per second of the playback: speed × frame rate of the file
  get fps() {
    return this.speed * this.fileFps;
  }

  set fps(fps) {
    this.speed = fps / this.fileFps;
  }

  // NOTE True while samples are read or geometries are built
  get isBuilding() {
    return this.task !== null;
  }

  get swapEntries() {
    return this.entries.filter(({ mode }) => mode === 'swap');
  }

  get vertexEntries() {
    return this.entries.filter(({ mode }) => mode === 'vertex');
  }

  get direction() {
    return this.speed < 0.0 ? -1 : 1;
  }

  // NOTE Builds the nodes at "time", in parts (see runProgressive). Called once by ABCLoader. "textureMemory" is in bytes.
  *setup(time, { textureMemory }) {
    this.currentTime = Three.MathUtils.clamp(time, this.startTime, this.endTime);

    const readSample = (schema) => schema.getSampleAtTime(this.currentTime);
    const updates = yield* buildUpdates(
      this.entries.filter(({ mode }) => mode !== 'vertex'),
      readSample
    );

    for (const entry of this.vertexEntries) {
      const { object, node } = entry;
      const { schema } = object;

      yield true;

      const sample = readSample(schema);

      yield true;

      const layout =
        schema.type === 'PolyMesh' ? yield* createPolyMeshLayout(sample, object.fullName) : null;
      const geometry = layout
        ? yield* createPolyMeshGeometry(sample, object.fullName, layout)
        : createPointsGeometry(sample);

      updates.push({ entry, sample, geometry });
      entry.vertexAnimation = yield* VertexAnimation.create(node, schema, {
        layout,
        geometry,
        textureMemory,
      });

      // NOTE Too large for the texture
      if (!entry.vertexAnimation) {
        entry.mode = 'swap';
      }
    }

    applyUpdates(updates);

    for (const { node, vertexAnimation } of this.vertexEntries) {
      const material = node.material;

      node.material = getAnimationBackend().createMaterial(material);
      material.dispose();

      // NOTE The bounds of the geometry are the bounds of one sample
      node.frustumCulled = false;

      vertexAnimation.setBlend(getBlend(vertexAnimation.schema, this.currentTime));
      yield* vertexAnimation.loadSample(vertexAnimation.floorIndex);
      yield* vertexAnimation.loadSample(vertexAnimation.ceilIndex);
    }

    this.shownFallbackKey = this.getFallbackFrame(this.currentTime).key;
    this.applyTime();
  }

  // NOTE Sample index of each 'swap' entry at the time
  getFallbackFrame(time) {
    const indices = this.swapEntries.map(({ object }) =>
      object.schema.timeSampling.getSampleIndex(time, object.schema.numSamples)
    );

    return { key: indices.join(','), indices };
  }

  // NOTE Time of the next 'swap' sample in the playback direction. Null at the end of the timeline without loop.
  getNextFallbackTime(indices) {
    const { direction } = this;
    let nextTime = null;

    this.swapEntries.forEach(({ object }, entryIndex) => {
      const { timeSampling, numSamples } = object.schema;
      const index = indices[entryIndex] + direction;

      if (index < 0 || index > timeSampling.getLastIndex(numSamples)) {
        return;
      }

      const time = timeSampling.getSampleTime(index);

      if (nextTime === null || (direction > 0 ? time < nextTime : time > nextTime)) {
        nextTime = time;
      }
    });

    if (nextTime === null && this.loop) {
      return direction > 0 ? this.startTime : this.endTime;
    }

    return nextTime;
  }

  // NOTE Fallback frame of the current time, then the next frames in the playback direction
  getFallbackWindow() {
    if (this.swapEntries.length === 0) {
      return [];
    }

    const window = [this.getFallbackFrame(this.currentTime)];

    while (window.length <= lookaheadFrames) {
      const time = this.getNextFallbackTime(window[window.length - 1].indices);

      if (time === null) {
        break;
      }

      window.push(this.getFallbackFrame(time));
    }

    return window;
  }

  // NOTE The clock does not wait. The last built frame stays on screen until the wanted frame is built.
  showFallbackFrame() {
    const window = this.getFallbackWindow();
    const wanted = window[0];

    this.fallbackWindow = window;

    if (wanted && wanted.key !== this.shownFallbackKey && this.fallbackFrames.has(wanted.key)) {
      applyUpdates(this.fallbackFrames.get(wanted.key));
      this.fallbackFrames.delete(wanted.key);
      this.shownFallbackKey = wanted.key;
    }

    this.fallbackFrames.forEach((updates, key) => {
      if (!window.some((frame) => frame.key === key)) {
        disposeUpdates(updates);
        this.fallbackFrames.delete(key);
      }
    });
  }

  // NOTE The vertex animation cannot show a sample (see VertexAnimation.failed). The entry swaps its geometry.
  useFallback(entry) {
    entry.mode = 'swap';
    entry.vertexAnimation.dispose();
    entry.vertexAnimation = null;
    entry.node.frustumCulled = true;

    // NOTE Keys of fallback frames have one more entry
    this.cancelTask();
    this.fallbackFrames.forEach((updates) => disposeUpdates(updates));
    this.fallbackFrames.clear();
    this.shownFallbackKey = null;
  }

  getXformSample(entry, index) {
    entry.xformSamples = entry.xformSamples ?? new Map();

    if (!entry.xformSamples.has(index)) {
      entry.xformSamples.set(index, entry.object.schema.getSample(index));
    }

    return entry.xformSamples.get(index);
  }

  // NOTE Shows the current time
  applyTime() {
    if (this.disposed) {
      return;
    }

    const time = this.currentTime;
    let hasXforms = false;

    for (const entry of this.entries) {
      const { mode, object, vertexAnimation } = entry;

      if (mode === 'xform') {
        const { floorIndex, ceilIndex, alpha } = getBlend(object.schema, time);
        const floor = this.getXformSample(entry, floorIndex);
        const ceil = this.getXformSample(entry, ceilIndex);

        entry.localMatrix = blendMatrices(
          floor.matrix,
          ceil.matrix,
          alpha,
          entry.localMatrix ?? new Three.Matrix4()
        );
        entry.inherits = floor.inherits;
        hasXforms = true;
      } else if (mode === 'vertex' && vertexAnimation.failed) {
        this.useFallback(entry);
      } else if (mode === 'vertex') {
        vertexAnimation.setBlend(getBlend(object.schema, time));
      }
    }

    if (hasXforms) {
      applyMatrices(this.entries);
    }

    this.showFallbackFrame();

    // NOTE A fallback frame that is not needed soon is not built
    if (
      this.job?.key !== undefined &&
      !this.fallbackWindow.some(({ key }) => key === this.job.key)
    ) {
      this.cancelTask();
    }

    this.runNextJob();
  }

  createFrameJob({ key, indices }) {
    const entries = this.swapEntries;
    const sampleIndices = new Map(
      entries.map(({ object }, index) => [object.schema, indices[index]])
    );

    return {
      key,
      run: () => buildUpdates(entries, (schema) => schema.getSample(sampleIndices.get(schema))),
      done: (updates) => {
        if (this.fallbackWindow.some((frame) => frame.key === key)) {
          this.fallbackFrames.set(key, updates);
        } else {
          disposeUpdates(updates);
        }
      },
      // NOTE The frame stays as it is
      fail: () => this.fallbackFrames.set(key, []),
    };
  }

  createSampleJob(vertexAnimation, index) {
    return {
      run: () => vertexAnimation.loadSample(index, this.direction),
      fail: () => {
        vertexAnimation.failed = true;
      },
    };
  }

  // NOTE In order: samples to show now, fallback frame to show now, samples and fallback frames to show next
  getNextJob() {
    const { direction, loop } = this;
    const vertexAnimations = this.vertexEntries.map(({ vertexAnimation }) => vertexAnimation);
    const missingFrames = this.fallbackWindow.filter(
      ({ key }) => key !== this.shownFallbackKey && !this.fallbackFrames.has(key)
    );

    for (const vertexAnimation of vertexAnimations) {
      const index = vertexAnimation.getMissingSample(direction, loop, true);

      if (index !== null) {
        return this.createSampleJob(vertexAnimation, index);
      }
    }

    if (missingFrames[0] && missingFrames[0] === this.fallbackWindow[0]) {
      return this.createFrameJob(missingFrames[0]);
    }

    for (const vertexAnimation of vertexAnimations) {
      const index = vertexAnimation.getMissingSample(direction, loop);

      if (index !== null) {
        return this.createSampleJob(vertexAnimation, index);
      }
    }

    return missingFrames[0] ? this.createFrameJob(missingFrames[0]) : null;
  }

  runNextJob() {
    if (this.task || this.disposed) {
      return;
    }

    const job = this.getNextJob();

    if (!job) {
      return;
    }

    const task = runProgressive(job.run());

    this.task = task;
    this.job = job;

    task.promise
      .then((result) => job.done?.(result))
      .catch((error) => {
        console.error(error);
        job.fail();
      })
      .finally(() => {
        this.task = null;
        this.job = null;
        this.applyTime();
      });
  }

  // NOTE A cancelled task does not settle. Its generator disposes its new geometries.
  cancelTask() {
    this.task?.cancel();
    this.task = null;
    this.job = null;
  }

  play() {
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  stop() {
    this.playing = false;
    this.time = this.startTime;
  }

  // NOTE Delta is in seconds
  update(delta) {
    if (!this.playing || this.disposed) {
      return;
    }

    const { startTime, endTime } = this;
    const duration = endTime - startTime;
    let time = this.currentTime + delta * this.speed;

    if (this.loop && duration > 0.0) {
      // NOTE The last frame shows for one frame time before the first frame, as in Blender
      time = startTime + modulo(time - startTime, duration + 1.0 / this.fileFps);
    } else if (time > endTime || time < startTime) {
      time = Three.MathUtils.clamp(time, startTime, endTime);
      this.playing = false;
    }

    this.currentTime = time;
    this.applyTime();
  }

  dispose() {
    this.disposed = true;
    this.playing = false;
    this.cancelTask();

    this.fallbackFrames.forEach((updates) => disposeUpdates(updates));
    this.fallbackFrames.clear();

    this.entries.forEach(({ vertexAnimation }) => vertexAnimation?.dispose());

    this.traverse((node) => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
  }
}
