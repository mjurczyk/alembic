import { createContext, runJob } from './decodeJobs.js';

// NOTE Worker of WabcWorkers. Jobs run one at a time, in the order they come: surface samples must be decoded in order.
let context = null;
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      if (data.type === 'open') {
        context = createContext(data.bytes);
        self.postMessage({ id: data.id, result: true });

        return;
      }

      const { result, transfer } = await runJob(context, data);

      self.postMessage({ id: data.id, result }, transfer);
    } catch (error) {
      self.postMessage({ id: data.id, error: error.message });
    }
  });
};
