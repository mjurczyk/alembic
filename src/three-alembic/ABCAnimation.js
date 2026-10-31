import * as Three from 'three';
import { runProgressive } from './scene/progressive.js';
import { applySamples } from './scene/sceneNodes.js';

const clampFrame = (index, count) =>
  Three.MathUtils.clamp(Math.round(index), 0, Math.max(0, count - 1));

// NOTE Root node of an animated file. Same playback interface as FrameVolumeAnimation of three-openvdb.
// Frames are the samples of the animated object with the most samples. Other objects show the sample at the frame time.
// A new frame is built in parts (see runProgressive). The old frame shows until the new frame is complete.
export class ABCAnimation extends Three.Group {
  isABCAnimation = true;

  fps = 24.0;
  loop = true;
  playing = false;
  disposed = false;

  // NOTE Frame on screen
  currentFrame = 0;
  // NOTE Frame to show. While a frame is built, the playback continues, and the newest target is built next.
  targetFrame = 0;
  task = null;
  time = 0.0;

  constructor(entries, { numSamples, timeSampling }) {
    super();

    this.entries = entries;
    this.totalFrames = numSamples;
    this.timeSampling = timeSampling;

    // NOTE The frame rate of the file. Average for cyclic and acyclic time samplings.
    const duration = timeSampling.getSampleTime(numSamples - 1) - timeSampling.getSampleTime(0);

    if (duration > 0) {
      this.fps = (numSamples - 1) / duration;
    }
  }

  get frame() {
    return this.currentFrame;
  }

  set frame(index) {
    this.targetFrame = clampFrame(index, this.totalFrames);
    this.buildTargetFrame();
  }

  // NOTE True while a frame is built
  get isBuilding() {
    return this.task !== null;
  }

  buildTargetFrame() {
    if (this.task || this.disposed || this.targetFrame === this.currentFrame) {
      return;
    }

    const frame = this.targetFrame;
    const time = this.timeSampling.getSampleTime(frame);

    this.task = runProgressive(
      applySamples(this.entries, (schema) => schema.getSampleAtTime(time), { onlyAnimated: true })
    );

    this.task.promise
      .then(() => {
        this.currentFrame = frame;
      })
      .catch((error) => {
        console.error(error);
        this.targetFrame = this.currentFrame;
      })
      .finally(() => {
        this.task = null;
        this.buildTargetFrame();
      });
  }

  play() {
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  stop() {
    this.playing = false;
    this.time = 0.0;
    this.frame = 0;
  }

  // NOTE Delta is in seconds
  update(delta) {
    if (!this.playing || this.totalFrames < 2) {
      return;
    }

    this.time += delta * this.fps;

    const steps = Math.floor(this.time);

    if (steps < 1) {
      return;
    }

    this.time -= steps;

    let next = this.targetFrame + steps;

    if (next >= this.totalFrames) {
      if (this.loop) {
        next %= this.totalFrames;
      } else {
        next = this.totalFrames - 1;
        this.playing = false;
      }
    }

    this.frame = next;
  }

  dispose() {
    this.disposed = true;
    this.playing = false;
    this.task?.cancel();
    this.task = null;

    this.traverse((node) => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
  }
}
