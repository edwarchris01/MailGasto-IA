import 'reflect-metadata';
import { readConfig } from './config.js';
import { Database } from './db.js';

const db = new Database(readConfig());
db.migrate().finally(() => db.onApplicationShutdown()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
