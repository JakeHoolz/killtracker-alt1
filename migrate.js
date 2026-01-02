const { migrate } = require('./db');

migrate()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log('Database migrated');
    process.exit(0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Migration failed', err);
    process.exit(1);
  });
