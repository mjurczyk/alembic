// NOTE All errors for files that are not valid Alembic archives, for each container
export class AlembicError extends Error {
  constructor(message) {
    super(message);

    this.name = 'AlembicError';
  }
}
