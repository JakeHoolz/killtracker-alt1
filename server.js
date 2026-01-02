const express = require('express');
const path = require('path');
const api = require('./api');

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT_DIR = path.join(__dirname);

app.use('/api', api);
app.use(express.static(ROOT_DIR, { extensions: ['html'] }));

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Kill Tracker available at http://localhost:${PORT}`);
});
