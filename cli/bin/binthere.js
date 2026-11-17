#!/usr/bin/env node
import process from 'node:process';
import { run } from '../src/cli.js';

// Treat a closed pipe as normal shell-pipeline behavior (`binthere get URL | head`).
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
process.stderr.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
});

process.exitCode = await run(process.argv.slice(2));
