var express = require("express");
var app = module.exports = express();
var auth = require("auth");

// Export route handlers and models in case they are needed from other modules.
exports.handlers = require("./controllers/farmer");

// Configure view Engine and paths.
app.set("views", __dirname + "/views");
app.set("viewengine", "jade");

// Setup routes
app.get('/farmer', auth.middleware.isFarmer, exports.handlers.dashboard);


