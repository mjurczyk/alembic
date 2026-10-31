import { AlembicError } from './AlembicError.js';

// NOTE f64 bytes 0x7f9fffffffffffff. Compare exactly (FORMAT.md 4.1).
export const acyclicTimePerCycle = Number.MAX_VALUE / 32;

// NOTE Times closer than this are equal when a time is mapped to a sample, as in the C++ reader (FORMAT.md 4.2)
export const timeEpsilon = 1e-5;

// NOTE Sample index <-> time (FORMAT.md section 4)
export class TimeSampling {
  type;
  timePerCycle;
  storedTimes;
  maxNumSamples;

  constructor({ timePerCycle, storedTimes, maxNumSamples }) {
    if (storedTimes.length === 0) {
      throw new AlembicError('Time sampling has no stored times.');
    }

    if (timePerCycle === acyclicTimePerCycle) {
      this.type = 'acyclic';
    } else if (storedTimes.length === 1) {
      this.type = 'uniform';
    } else {
      this.type = 'cyclic';
    }

    if (this.type !== 'acyclic' && !(timePerCycle > 0 && timePerCycle < Infinity)) {
      throw new AlembicError(`Time sampling has time per cycle ${timePerCycle}. It must be > 0.`);
    }

    if (!Number.isFinite(storedTimes[0])) {
      throw new AlembicError(`Time sampling has stored time ${storedTimes[0]}.`);
    }

    for (let index = 1; index < storedTimes.length; index++) {
      if (!(storedTimes[index - 1] < storedTimes[index] && storedTimes[index] < Infinity)) {
        throw new AlembicError('Stored times of a time sampling do not increase.');
      }
    }

    if (
      this.type === 'cyclic' &&
      !(storedTimes[storedTimes.length - 1] - storedTimes[0] < timePerCycle)
    ) {
      throw new AlembicError('Stored times of a cyclic time sampling are longer than one cycle.');
    }

    this.timePerCycle = timePerCycle;
    this.storedTimes = Float64Array.from(storedTimes);
    this.maxNumSamples = maxNumSamples;
  }

  getSampleTime(index) {
    const { storedTimes, timePerCycle } = this;

    if (!Number.isSafeInteger(index) || index < 0) {
      throw new RangeError(`Sample index ${index} is not valid.`);
    }

    if (this.type === 'uniform') {
      return storedTimes[0] + index * timePerCycle;
    }

    if (this.type === 'cyclic') {
      const numTimes = storedTimes.length;

      return storedTimes[index % numTimes] + Math.floor(index / numTimes) * timePerCycle;
    }

    if (index >= storedTimes.length) {
      throw new RangeError(
        `Sample index ${index} is not valid. Acyclic time sampling has ${storedTimes.length} times.`
      );
    }

    return storedTimes[index];
  }

  getLastIndex(numSamples) {
    if (!Number.isSafeInteger(numSamples) || numSamples < 0) {
      throw new RangeError(`Sample count ${numSamples} is not valid.`);
    }

    const last = Math.max(numSamples, 1) - 1;

    return this.type === 'acyclic' ? Math.min(last, this.storedTimes.length - 1) : last;
  }

  // NOTE Last sample at or before "time" + timeEpsilon, clamped to 0...numSamples - 1 (FORMAT.md 4.2).
  // Binary search works, because times increase.
  getSampleIndex(time, numSamples) {
    const last = this.getLastIndex(numSamples);

    if (!(time > this.getSampleTime(0))) {
      return 0;
    }

    if (this.getSampleTime(last) - time <= timeEpsilon) {
      return last;
    }

    let low = 0;
    let high = last;

    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);

      if (this.getSampleTime(middle) - time <= timeEpsilon) {
        low = middle;
      } else {
        high = middle;
      }
    }

    return low;
  }

  // NOTE First sample at or after "time", clamped to 0...numSamples - 1.
  // A sample less than timeEpsilon before "time" also counts.
  getCeilIndex(time, numSamples) {
    const last = this.getLastIndex(numSamples);

    if (!(time > this.getSampleTime(0))) {
      return 0;
    }

    const floorIndex = this.getSampleIndex(time, numSamples);

    if (floorIndex === last || Math.abs(time - this.getSampleTime(floorIndex)) <= timeEpsilon) {
      return floorIndex;
    }

    return floorIndex + 1;
  }

  // NOTE Sample nearest to "time". At equal distance, the floor sample, as in the C++ reader.
  getNearestIndex(time, numSamples) {
    const floorIndex = this.getSampleIndex(time, numSamples);
    const ceilIndex = this.getCeilIndex(time, numSamples);

    if (floorIndex === ceilIndex) {
      return floorIndex;
    }

    const floorDistance = Math.abs(time - this.getSampleTime(floorIndex));
    const ceilDistance = Math.abs(this.getSampleTime(ceilIndex) - time);

    return floorDistance <= ceilDistance ? floorIndex : ceilIndex;
  }

  // NOTE Floor and ceil samples of "time". "alpha" is 0 at the floor sample and 1 at the ceil sample.
  getBlend(time, numSamples) {
    const floorIndex = this.getSampleIndex(time, numSamples);
    const ceilIndex = this.getCeilIndex(time, numSamples);

    if (floorIndex === ceilIndex) {
      return { floorIndex, ceilIndex, alpha: 0 };
    }

    const floorTime = this.getSampleTime(floorIndex);
    const ceilTime = this.getSampleTime(ceilIndex);
    const alpha = Math.min(Math.max((time - floorTime) / (ceilTime - floorTime), 0), 1);

    return { floorIndex, ceilIndex, alpha };
  }
}
