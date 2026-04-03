#!/usr/bin/env node

const os = require('os');

// LOW_CONCURRENCY=1 forces single concurrency
if (process.env.LOW_CONCURRENCY === '1') {
  console.log(1);
  process.exit(0);
}

// Half of CPU cores (minimum 2)
const cores = os.cpus().length;
const concurrency = Math.max(2, Math.floor(cores / 2));

console.log(concurrency);
