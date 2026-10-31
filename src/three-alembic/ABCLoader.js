import * as Three from 'three';
import { AlembicReader, loadAlembic } from 'alembic';
import { ABCAnimation } from './ABCAnimation.js';
import {
  applySamples,
  collectEntries,
  createNode,
  getTimeline,
  setNodeInfo,
} from './scene/sceneNodes.js';
import { runProgressive } from './scene/progressive.js';

const defaultOptions = {
  sampleIndex: 0,
  // NOTE Seconds. If set, it is used instead of sampleIndex.
  time: null,
  timeMode: 'floor',
  // NOTE Memory limit of the vertex animation texture of one object, in bytes
  textureMemory: 256 * 1024 * 1024,
};

class ABCLoader extends Three.Loader {
  options = { ...defaultOptions };

  constructor(manager) {
    super(manager);
  }

  // NOTE { sampleIndex, time, timeMode, textureMemory }. timeMode is 'floor', 'ceil' or 'nearest'.
  setOptions(options) {
    this.options = { ...this.options, ...options };

    return this;
  }

  load(url, onLoad, _onProgress_ /* NOTE Unused */, onError) {
    const resolvedUrl = this.manager.resolveURL(this.path + url);

    this.manager.itemStart(resolvedUrl);

    loadAlembic(resolvedUrl)
      .then((reader) => this.parse(reader))
      .then((group) => {
        onLoad(group);
        this.manager.itemEnd(resolvedUrl);
      })
      .catch((error) => {
        if (onError) {
          onError(error);
        } else {
          console.error(error);
        }

        this.manager.itemError(resolvedUrl);
        this.manager.itemEnd(resolvedUrl);
      });
  }

  // NOTE Source is the bytes of a file, or an AlembicReader. A reader can be parsed again for other samples.
  // An animated file gives an ABCAnimation, a static file gives a Group.
  async parse(source) {
    const reader =
      source instanceof AlembicReader
        ? source
        : await new AlembicReader().read(
            source instanceof ArrayBuffer ? new Uint8Array(source) : source
          );
    const entries = collectEntries(reader.archive.root);
    const timeline = getTimeline(entries);
    const animation = timeline.timeSampling ? new ABCAnimation(entries, timeline) : null;

    // NOTE The root object has no schema. In an animated file, its node is the ABCAnimation.
    entries.forEach((entry) => {
      const { object, parent } = entry;

      entry.node = !parent && animation ? setNodeInfo(animation, object) : createNode(object);
      parent?.node.add(entry.node);
    });

    // NOTE Built in parts, so the page keeps its frame rate
    const generator = animation
      ? animation.setup(this.getStartTime(timeline), this.options)
      : applySamples(entries, (schema) => this.readSample(schema));

    await runProgressive(generator).promise;

    return entries[0].node;
  }

  readSample(schema) {
    const { sampleIndex, time, timeMode } = this.options;

    return time === null ? schema.getSample(sampleIndex) : schema.getSampleAtTime(time, timeMode);
  }

  // NOTE Start time of an animation: "time", or the time of frame "sampleIndex"
  getStartTime({ numSamples, timeSampling }) {
    const { sampleIndex, time } = this.options;

    return time === null
      ? timeSampling.getSampleTime(Math.min(sampleIndex, timeSampling.getLastIndex(numSamples)))
      : time;
  }
}

export { ABCLoader };
