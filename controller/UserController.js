const dotenv = require("dotenv");
dotenv.config();
const authentication = require("../lib/authentication-service");
const staffUsers = require("../lib/staff-user-service");
const { UserServiceError } = require("../lib/user-service-shared");
// Coordinates send known error behavior for this module.
const sendKnownError = (res, error) => {
  if (error?.code === "P2002") {
    res.status(409).send({ error: "Username is already in use" });
    return true;
  }
  if (error?.code === "P2025") {
    res.status(404).send({ error: "User not found" });
    return true;
  }
  if (error?.code === "P2034") {
    res.status(409).send({ error: "Account change conflicted; try again" });
    return true;
  }
  return false;
};

module.exports = {
  // Enforces the existing authentication and session behavior.
  signIn: async (req, res) => {
    try {
      const result = await authentication.signIn({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.send(result);
    } catch (error) {
      if (error instanceof UserServiceError)
        return res.status(error.status).send(error.body);
      return res.status(500).send({ error: "Unable to sign in" });
    }
  },

  // Creates  with the current contract.
  create: async (req, res) => {
    try {
      const result = await staffUsers.create({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.status(201).send(result);
    } catch (error) {
      if (error instanceof UserServiceError)
        return res.status(error.status).send(error.body);
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to create user" });
    }
  },

  // Coordinates list behavior for this module.
  list: async (req, res) => {
    try {
      const result = await staffUsers.list({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.send(result);
    } catch (error) {
      if (error instanceof UserServiceError)
        return res.status(error.status).send(error.body);
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to list users" });
    }
  },

  // Updates  without changing user-visible behavior.
  update: async (req, res) => {
    try {
      const result = await staffUsers.update({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.send(result);
    } catch (error) {
      if (error instanceof UserServiceError)
        return res.status(error.status).send(error.body);
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to update user" });
    }
  },

  // Removes or clears  using the existing workflow.
  remove: async (req, res) => {
    try {
      const result = await staffUsers.remove({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.send(result);
    } catch (error) {
      if (error instanceof UserServiceError)
        return res.status(error.status).send(error.body);
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to remove user" });
    }
  },

  // Loads level by token for the current workflow.
  getLevelByToken: async (req, res) => res.send({ level: req.user.level }),
};
