const path = require("node:path");
const {
  ensureImageVariant,
  ImageProcessingError,
} = require("../lib/image-variants");

module.exports = {
  variant: async (req, res) => {
    try {
      const filePath = await ensureImageVariant(
        path.resolve("uploads"),
        req.params.filename,
        req.params.variant,
      );
      // EN: Only this validated route may serve hidden derivative files; the general uploads static route keeps dotfiles private.
      // FI: Vain tämä tarkistettu reitti saa palvella piilotettuja kuvaversioita; yleinen uploads-reitti pitää pistetiedostot yksityisinä.
      res
        .type("webp")
        .sendFile(filePath, { maxAge: "1d", dotfiles: "allow" }, (error) => {
          if (!error || res.headersSent || res.destroyed) return;
          res
            .status(error.code === "ENOENT" ? 404 : 500)
            .type("json")
            .send({ error: "Unable to load image" });
        });
    } catch (error) {
      let status = 500;
      if (error instanceof ImageProcessingError)
        status = error.status === 400 ? 404 : error.status;
      else if (error.code === "ENOENT") status = 404;
      if (status === 429) res.set("Retry-After", "2");
      res.status(status).send({
        error:
          status === 429
            ? "Image processing is busy"
            : status === 500
              ? "Unable to load image"
              : "Image not found",
      });
    }
  },
};
