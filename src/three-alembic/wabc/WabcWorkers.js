import { createContext, runJob } from './decodeJobs.js';

// NOTE Workers that read .wabc samples off the main thread. Worker 0 decodes surface signs, which must be in order.
// The other workers build meshes and read the other tracks. Without Worker (for example in Node.js), or if a worker
// cannot start, the jobs run in the page, one at a time.

const getWorkerCount = () => {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 2;

  return Math.min(Math.max(cores - 1, 1), 4);
};

class InlineRunner {
  queue = Promise.resolve();
  ready = Promise.resolve();

  constructor(bytes) {
    this.context = createContext(bytes);
  }

  run(job) {
    const result = this.queue.then(() => runJob(this.context, job).then(({ result }) => result));

    this.queue = result.catch(() => {});

    return result;
  }

  terminate() {}
}

class WorkerRunner {
  nextId = 0;
  pending = new Map();

  constructor(worker, bytes) {
    this.worker = worker;
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
      this.fail(new Error(event.message || 'The worker failed.'));
    };
    this.ready = this.send({ type: 'open', bytes: bytes.slice() }, []);
  }

  fail(error) {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }

  send(job, transfer) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;

      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...job, id }, transfer);
    });
  }

  run(job, transfer = []) {
    return this.ready.then(() => this.send(job, transfer));
  }

  terminate() {
    this.worker.terminate();
    this.pending.forEach(({ reject }) => reject(new Error('The worker was stopped.')));
    this.pending.clear();
  }
}

export class WabcWorkers {
  next = 0;

  constructor(bytes, count = getWorkerCount()) {
    this.runners = [];

    if (typeof Worker !== 'undefined') {
      try {
        for (let index = 0; index < count; index++) {
          const worker = new Worker(new URL('./wabcWorker.js', import.meta.url), {
            type: 'module',
          });

          this.runners.push(new WorkerRunner(worker, bytes));
        }
      } catch (error) {
        this.runners.forEach((runner) => runner.terminate());
        this.runners = [];
        console.warn('The .wabc workers cannot start. Samples are read in the page.', error);
      }
    }

    if (this.runners.length === 0) {
      this.runners.push(new InlineRunner(bytes));
    }

    // NOTE A worker that cannot load its module fails at start: then all jobs run in the page
    this.ready = Promise.all(this.runners.map((runner) => runner.ready)).catch((error) => {
      console.warn('The .wabc workers cannot start. Samples are read in the page.', error);
      this.runners.forEach((runner) => runner.terminate());
      this.runners = [new InlineRunner(bytes)];
    });
  }

  // NOTE Signs of a surface sample, always on worker 0
  async decode(node, sample) {
    await this.ready;

    return this.runners[0].run({ type: 'decode', node, sample });
  }

  // NOTE Mesh of decoded signs, or one sample of an other track, on the next worker after worker 0
  async build(node, decoded) {
    await this.ready;

    return this.getBuilder().run({ type: 'build', node, decoded }, [
      decoded.signs.buffer,
      decoded.edges.buffer,
      decoded.tCodes.buffer,
    ]);
  }

  async read(node, sample) {
    await this.ready;

    return this.getBuilder().run({ type: 'read', node, sample });
  }

  getBuilder() {
    if (this.runners.length === 1) {
      return this.runners[0];
    }

    this.next = (this.next % (this.runners.length - 1)) + 1;

    return this.runners[this.next];
  }

  dispose() {
    this.runners.forEach((runner) => runner.terminate());
    this.runners = [];
  }
}
