const express = require("express");
const uploadRoutes = require("./route/upload");
const imageRoutes = require("./route/images");
const deleteRoutes = require("./route/delete");
const copyRoutes = require("./route/copy"); 

const app = express();

app.use("/upload", uploadRoutes);
app.use("/image", imageRoutes);
app.use("/delete", deleteRoutes);
app.use("/copy", copyRoutes); 

const PORT = process.env.PORT || 11000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
