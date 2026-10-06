const safeUserSelect = { id: true, name: true, username: true, level: true };
class UserServiceError extends Error {
  constructor(status, body) {
    super(body?.error || "Authentication failed");
    this.status = status;
    this.body = body;
  }
}
module.exports = { safeUserSelect, UserServiceError };
