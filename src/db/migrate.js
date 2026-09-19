const { migrate } = require('./database');
migrate();
console.log('Database migrated.');
