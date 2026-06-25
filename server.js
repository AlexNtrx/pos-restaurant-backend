const bodyParser = require("body-parser");
const express = require("express");
const app = express();
const cors = require("cors");

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());

const userController = require("./controller/UserController");
const UserController = require("./controller/UserController");

app.post("/api/user/signIn", (req, res) => UserController.signIn(req, res));

app.listen(3001, () => {
  console.log("API Server running on port 3001");
});
