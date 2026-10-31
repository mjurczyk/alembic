# three-alembic

three.js rendering of Alembic (`.abc`) files. WebGL and GLSL only.

- `ABCLoader` - loads `.abc` files into three.js objects. `loader.load( url, onLoad, onProgress, onError )` and `loader.loadAsync( url )` give a `Group` with the objects of the file, or an `ABCAnimation` if the file is animated. `loader.parse( source )` reads the bytes of a file (`Uint8Array` or `ArrayBuffer`), or an `AlembicReader` (read once, then parse it again for other frames).
- Transforms become a `Group`, meshes a `Mesh` with `MeshStandardMaterial`, and points `Points` with `PointsMaterial`. Other objects become a `Group`, with their children. Each object has `name`, and `userData.fullName` (path), `userData.metadata` and `userData.schema` (`'Xform'`, `'PolyMesh'`, `'Points'` or `null`).
- `loader.setOptions({ sampleIndex, time, timeMode })` selects the frame. `sampleIndex` is the frame number (default `0`). `time` is the time in seconds, and it is used instead of `sampleIndex` when set. `timeMode` is `'floor'` (default), `'ceil'` or `'nearest'`.
- `ABCAnimation` - a `Group` that plays an animated file, as `FrameVolumeAnimation` of `three-openvdb`. `animation.play()`, `pause()` and `stop()` control the playback. Call `animation.update( delta )` on each frame, with `delta` in seconds. `fps` (the frame rate of the file by default), `loop` (default `true`) and `frame` (`0` to `totalFrames - 1`) can be changed at any time. `animation.timeSampling.getSampleTime( frame )` gives the time of a frame, in seconds. `animation.dispose()` frees the geometries and materials.
