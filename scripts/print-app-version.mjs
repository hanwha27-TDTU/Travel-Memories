#!/usr/bin/env node
import { readAppVersion } from './lib/app-version.mjs';

try {
  process.stdout.write(readAppVersion());
} catch (error) {
  console.error(`print-app-version: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
