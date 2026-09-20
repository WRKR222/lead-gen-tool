const { db, migrate } = require('./database');
migrate();
console.log('Database migrated.');
db.close();
process.exit(0);
