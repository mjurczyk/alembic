import workerSource from './volumeWorker.js?worker-source';

// NOTE Density grids made in workers. Surface samples need the sample before: one worker, in order.
// Points samples use all workers.

let workerUrl = null;

const getWorkerUrl = () =>
  (workerUrl ??= URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));

export const getPointsWorkerCount = () =>
  Math.min(Math.max((navigator.hardwareConcurrency ?? 2) - 1, 1), 6);

class VolumeWorker {
  nextId = 0;
  pending = new Map();
  busy = 0;

  constructor() {
    this.worker = new Worker(getWorkerUrl());
    this.worker.onmessage = ({ data }) => {
      const callbacks = this.pending.get(data.id);

      this.pending.delete(data.id);

      if (data.error) {
        callbacks?.reject(new Error(data.error));
      } else {
        callbacks?.resolve(data.result);
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      this.pending.forEach(({ reject }) =>
        reject(new Error(event.message || 'The worker failed.'))
      );
      this.pending.clear();
    };
  }

  send(job, transfer = []) {
    this.busy++;

    return new Promise((resolve, reject) => {
      const id = this.nextId++;

      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...job, id }, transfer);
    }).finally(() => {
      this.busy--;
    });
  }

  terminate() {
    this.worker.terminate();
    this.pending.forEach(({ reject }) => reject(new Error('The worker was stopped.')));
    this.pending.clear();
  }
}

export class VolumeSource {
  // NOTE Samples that are ready (sample -> result) and samples in a worker (sample -> Promise)
  ready = new Map();
  running = new Map();
  // NOTE Results of older options are not kept
  version = 0;
  smooth = 0;
  info = null;
  workers = [];

  // NOTE "info": { kind, path, times, resolution, bbox }. "resolution" can be lower than asked for a surface.
  async open(bytes, { resolution, smooth }) {
    this.smooth = smooth;
    this.workers = [new VolumeWorker()];
    this.info = await this.workers[0].send({ type: 'open', bytes: bytes.slice(), resolution });

    if (this.info.kind === 'points') {
      const others = Array.from({ length: getPointsWorkerCount() - 1 }, () => new VolumeWorker());

      this.workers.push(...others);
      await Promise.all(
        others.map((worker) =>
          worker.send({ type: 'open', bytes: bytes.slice(), resolution, box: this.info.bbox })
        )
      );
    }

    return this.info;
  }

  get sampleCount() {
    return this.info?.times.length ?? 0;
  }

  // NOTE New options make all samples again. Gives the new info.
  async setOptions({ resolution, smooth }) {
    this.version++;
    this.ready.clear();
    this.running.clear();
    this.smooth = smooth;

    const [layout] = await Promise.all(
      this.workers.map((worker) => worker.send({ type: 'configure', resolution }))
    );

    this.info = { ...this.info, ...layout };

    return this.info;
  }

  // NOTE Result of the sample, or null when it is not ready. The sample and the next samples start in the workers.
  get(sample) {
    this.prefetch(sample);

    return this.ready.get(sample) ?? null;
  }

  prefetch(sample) {
    const count = this.sampleCount;
    const ahead = this.info.kind === 'points' ? this.workers.length * 2 : 2;

    // NOTE Keep only the samples from "sample" to "sample + ahead"
    this.ready.forEach((_, key) => {
      const distance = (key - sample + count) % count;

      if (distance > ahead) {
        this.ready.delete(key);
      }
    });

    for (let step = 0; step <= ahead; step++) {
      const next = (sample + step) % count;

      if (this.ready.has(next) || this.running.has(next)) {
        continue;
      }

      const worker = this.getWorker();

      if (!worker) {
        return;
      }

      this.start(worker, next);
    }
  }

  // NOTE A free worker. Surface jobs wait in the one worker; at most 2 jobs wait there.
  getWorker() {
    if (this.info.kind === 'surface') {
      return this.workers[0].busy < 2 ? this.workers[0] : null;
    }

    return this.workers.find((worker) => worker.busy === 0) ?? null;
  }

  start(worker, sample) {
    const version = this.version;
    const job = worker
      .send({ type: 'sample', sample, smooth: this.smooth })
      .then((result) => {
        if (version === this.version) {
          this.ready.set(sample, result);
        }
      })
      .catch((error) => console.error(error))
      .finally(() => {
        if (version === this.version) {
          this.running.delete(sample);
        }
      });

    this.running.set(sample, job);
  }

  dispose() {
    this.version++;
    this.workers.forEach((worker) => worker.terminate());
    this.workers = [];
    this.ready.clear();
    this.running.clear();
  }
}
