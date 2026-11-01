// NOTE Time samplings of the header (FORMAT.md 3.3, 8.3), and the samples in the sample range

// NOTE Times closer than this are equal, as in /alembic (alembic FORMAT.md 4.2)
const timeEpsilon = 1e-5;

export const getTime = (timeSampling, index) =>
  timeSampling.type === 'uniform'
    ? timeSampling.start + index * timeSampling.step
    : timeSampling.times[index];

// NOTE Sample indices of a property in the time range [start, end], in seconds. Null range: all samples.
// No sample in the range: the sample shown at "start".
export const selectSamples = (timeSampling, numSamples, range) => {
  const all = [...Array(Math.max(numSamples, 0)).keys()];

  if (!range || numSamples <= 1) {
    return all;
  }

  const selected = all.filter((index) => {
    const time = timeSampling.getSampleTime(index);

    return time >= range.start - timeEpsilon && time <= range.end + timeEpsilon;
  });

  return selected.length > 0 ? selected : [timeSampling.getSampleIndex(range.start, numSamples)];
};

// NOTE Uniform samplings stay uniform. Cyclic and acyclic samplings become acyclic, with the times of the selected samples.
export const toHeaderTimeSampling = (timeSampling, indices) => {
  const isContiguous = indices.every((index, item) => index === indices[0] + item);

  if (timeSampling.type === 'uniform' && isContiguous) {
    return {
      type: 'uniform',
      start: timeSampling.getSampleTime(indices[0]),
      step: timeSampling.timePerCycle,
    };
  }

  return { type: 'acyclic', times: indices.map((index) => timeSampling.getSampleTime(index)) };
};

// NOTE Each time sampling is stored once. Gives the index in "timeSamplings".
export const createTimeSamplingTable = () => {
  const timeSamplings = [];
  const keys = new Map();

  return {
    timeSamplings,
    add(timeSampling) {
      const key = JSON.stringify(timeSampling);

      if (!keys.has(key)) {
        keys.set(key, timeSamplings.length);
        timeSamplings.push(timeSampling);
      }

      return keys.get(key);
    },
  };
};
