# alembic

Alembic (`.abc`) file reader in JavaScript. No dependencies, no renderer.

- `loadAlembic( url )`, `AlembicReader` - read `.abc` files. `reader.archive.root` is the top object of the file, `reader.archive.findObject( path )` finds an object by its path (for example `'/Cube/Cube_241'`), and `reader.archive.metadata` has the file information (for example the application that saved the file).
- `AlembicObject` - an object of the file (for example a mesh or a transform). Objects have `name`, `fullName` (path), `metadata`, `children`, `getChild( name )` and `properties`.
- `CompoundProperty`, `ScalarProperty`, `ArrayProperty` - object data. `properties.get( name )` gives a property. `property.getSample( index )` gives the values of a frame: typed arrays (for example `Float32Array`), or an `Array` of strings for text. Array properties give `{ values, dimensions }`.
- `TimeSampling` - `property.timeSampling.getSampleTime( index )` gives the time of a frame, in seconds. `getSampleIndex( time, numSamples )` gives the frame shown at the given time.
