class CatalogWriteError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}
module.exports = { CatalogWriteError };
