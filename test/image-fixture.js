// EN: A complete PNG is required now that uploads decode pixels rather than checking only the signature.
// FI: Täydellinen PNG tarvitaan, koska lataukset purkavat nyt pikselit pelkän tunnisteen tarkistamisen sijaan.
module.exports.png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQqLD5D8IMMAYAPkwHbZPQqckAAAAASUVORK5CYII=",
  "base64",
);
