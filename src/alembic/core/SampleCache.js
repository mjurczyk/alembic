// NOTE Repeated and shared samples give the same decoded object while in use.
// Weak references let unused samples be garbage collected.
export class SampleCache {
  samples = new Map();
  registry = new FinalizationRegistry((key) => {
    if (!this.samples.get(key)?.deref()) {
      this.samples.delete(key);
    }
  });

  get(key, decode) {
    const cached = this.samples.get(key)?.deref();

    if (cached) {
      return cached;
    }

    const sample = decode();

    this.samples.set(key, new WeakRef(sample));
    this.registry.register(sample, key);

    return sample;
  }
}
