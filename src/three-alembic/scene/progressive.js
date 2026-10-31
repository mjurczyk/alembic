// NOTE Runs a generator in parts of at most "budget" milliseconds, so the page keeps its frame rate.
// "yield true" ends the part at once. Use it before a long step that cannot be split.
// Same method as FrameVolume of three-openvdb.
// REF https://github.com/gkjohnson/three-mesh-bvh/blob/master/example/voxelize.js#L326
export const runProgressive = (generator, budget = 12) => {
  let timeout = null;
  let cancelled = false;

  const promise = new Promise((resolve, reject) => {
    const onTimeout = () => {
      const startTime = performance.now();

      try {
        while (performance.now() - startTime < budget) {
          const { value, done } = generator.next();

          if (done) {
            timeout = null;
            resolve(value);

            return;
          }

          if (value === true) {
            break;
          }
        }
      } catch (error) {
        timeout = null;
        reject(error);

        return;
      }

      if (!cancelled) {
        timeout = setTimeout(onTimeout, 0);
      }
    };

    onTimeout();
  });

  const cancel = () => {
    cancelled = true;
    clearTimeout(timeout);
    generator.return();
  };

  return { promise, cancel };
};
