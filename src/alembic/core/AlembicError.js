// NOTE Errors for files that are not valid Alembic archives, for each container. Also the load errors of loadAlembic.
export class AlembicError extends Error {
  constructor(message, options) {
    super(message, options);

    this.name = 'AlembicError';
  }
}
