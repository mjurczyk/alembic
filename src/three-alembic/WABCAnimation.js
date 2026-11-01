import * as Three from 'three';

// NOTE Times closer than this are equal, as in alembic (FORMAT.md 4.2 of alembic)
const timeEpsilon = 1e-5;
// NOTE Samples read before they are needed, in the playback direction
const lookahead = 6;
// NOTE Reads of one node at the same time. When the time jumps (a slider), old reads do not wait in a queue before
// the new sample. When a read ends, the next sample of the window is asked for.
const maxRequests = 2;
// NOTE Spare room in a GPU buffer that grows
const growth = 1.25;

const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

// NOTE Last sample with a time at or before "time", from 0 to count − 1
export const findSample = (getTime, count, time) => {
  let low = 0;
  let high = count - 1;

  while (low < high) {
    const middle = (low + high + 1) >> 1;

    if (getTime(middle) - time <= timeEpsilon) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
};

// NOTE The arrays go into the GPU buffers of the geometry when they fit; else a buffer is made with spare room.
// The draw range shows only the vertices of this sample.
const setAttribute = (geometry, name, array, itemSize) => {
  if (!array) {
    if (geometry.getAttribute(name)) {
      geometry.deleteAttribute(name);
    }

    return;
  }

  const attribute = geometry.getAttribute(name);

  if (
    attribute &&
    attribute.array.length >= array.length &&
    attribute.array.constructor === array.constructor
  ) {
    attribute.array.set(array);
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, array.length);
    attribute.needsUpdate = true;

    return;
  }

  const buffer = new array.constructor(Math.ceil((array.length * growth) / itemSize) * itemSize);

  buffer.set(array);
  geometry.setAttribute(
    name,
    new Three.BufferAttribute(buffer, itemSize).setUsage(Three.DynamicDrawUsage)
  );
};

export const applySampleArrays = (object, arrays) => {
  const { geometry } = object;

  setAttribute(geometry, 'position', arrays.position, 3);

  if (object.isMesh) {
    setAttribute(geometry, 'normal', arrays.normal, 3);
    setAttribute(geometry, 'uv', arrays.uv, 2);

    const index = geometry.getIndex();

    if (index && index.array.length >= arrays.index.length) {
      index.array.set(arrays.index);
      index.clearUpdateRanges();
      index.addUpdateRange(0, arrays.index.length);
      index.needsUpdate = true;
    } else {
      const buffer = new Uint32Array(Math.ceil((arrays.index.length * growth) / 3) * 3);

      buffer.set(arrays.index);
      geometry.setIndex(new Three.BufferAttribute(buffer, 1).setUsage(Three.DynamicDrawUsage));
    }
  }

  geometry.setDrawRange(0, object.isMesh ? arrays.index.length : arrays.vertexCount);
  object.userData.vertexCount = arrays.vertexCount;
  object.userData.version = (object.userData.version ?? 0) + 1;
};

// NOTE Root node of an animated .wabc file. The same playback members as ABCAnimation: "time" in seconds, "speed",
// "loop", "frame", play(), pause(), stop() and update(delta). Each node uses the times of its own samples.
// Samples are read by workers (WabcWorkers), ahead of the playback. A new sample is shown when it is read. Until
// then the last sample stays on screen, and the clock does not wait.
export class WABCAnimation extends Three.Group {
  isWABCAnimation = true;

  speed = 1.0;
  loop = true;
  playing = false;
  disposed = false;
  currentTime = 0.0;

  constructor(entries, timeline, workers) {
    super();

    this.entries = entries;
    this.timeline = timeline;
    this.workers = workers;
    this.totalFrames = timeline.count;
    this.startTime = timeline.getTime(0);
    this.endTime = Math.max(
      ...entries.map(({ track, matrixTimes }) =>
        Math.max(
          track ? track.getSampleTime(track.numSamples - 1) : -Infinity,
          matrixTimes.at(-1) ?? -Infinity
        )
      )
    );

    const duration = timeline.getTime(timeline.count - 1) - this.startTime;

    this.fileFps = duration > 0 ? (timeline.count - 1) / duration : 24.0;
  }

  get time() {
    return this.currentTime;
  }

  set time(time) {
    this.currentTime = Three.MathUtils.clamp(time, this.startTime, this.endTime);
    this.applyTime();
  }

  get frame() {
    return findSample(this.timeline.getTime, this.totalFrames, this.currentTime);
  }

  set frame(index) {
    this.time = this.timeline.getTime(
      Three.MathUtils.clamp(Math.round(index), 0, this.totalFrames - 1)
    );
  }

  get fps() {
    return this.speed * this.fileFps;
  }

  set fps(fps) {
    this.speed = fps / this.fileFps;
  }

  // NOTE True while the sample on screen is not the sample of the time
  get isBuilding() {
    return this.entries.some(({ track, wanted, shown }) => track && wanted !== shown);
  }

  // NOTE Matrices at once. Geometry samples come from the cache of each node, and the next samples are asked for.
  applyTime() {
    for (const entry of this.entries) {
      const { node, matrices, matrixTimes, track } = entry;

      if (matrices.length > 1) {
        const sample = findSample((index) => matrixTimes[index], matrices.length, this.currentTime);

        node.matrix.fromArray(matrices[sample]);
        node.matrixWorldNeedsUpdate = true;
      }

      if (track && track.numSamples > 1) {
        entry.wanted = findSample(
          (index) => track.getSampleTime(index),
          track.numSamples,
          this.currentTime
        );
        this.showWanted(entry);
        this.requestAhead(entry);
      }
    }
  }

  showWanted(entry) {
    const arrays = entry.cache.get(entry.wanted);

    if (arrays && entry.shown !== entry.wanted) {
      entry.applyArrays(arrays);
      entry.shown = entry.wanted;
      this.dispatchEvent({ type: 'sample', node: entry.node, sample: entry.wanted });
    }
  }

  // NOTE The wanted sample and the next ones in the playback direction. Samples out of that window leave the cache.
  getWindow(entry) {
    const { numSamples } = entry.track;
    const direction = this.speed < 0.0 ? -1 : 1;
    const window = [];

    for (let step = 0; step <= lookahead && window.length < numSamples; step++) {
      const sample = entry.wanted + step * direction;

      if (sample < 0 || sample >= numSamples) {
        if (!this.loop) {
          break;
        }

        window.push(modulo(sample, numSamples));
      } else {
        window.push(sample);
      }
    }

    return window;
  }

  requestAhead(entry) {
    const window = this.getWindow(entry);

    for (const sample of entry.cache.keys()) {
      if (!window.includes(sample)) {
        entry.cache.delete(sample);
      }
    }

    for (const sample of window) {
      if (entry.requested.size >= maxRequests) {
        break;
      }

      if (!entry.cache.has(sample) && !entry.requested.has(sample)) {
        entry.requested.add(sample);
        entry
          .readArrays(sample)
          .then((arrays) => {
            if (this.disposed || !this.getWindow(entry).includes(sample)) {
              return;
            }

            entry.cache.set(sample, arrays);
            this.showWanted(entry);
          })
          .catch((error) => console.error(error))
          .finally(() => {
            entry.requested.delete(sample);

            if (!this.disposed) {
              this.requestAhead(entry);
            }
          });
      }
    }
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
      // NOTE The last frame shows for one frame time before the first frame, as in ABCAnimation
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
    this.workers?.dispose();
    this.entries.forEach(({ cache }) => cache?.clear());

    this.traverse((node) => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
  }
}
