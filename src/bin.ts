#!/usr/bin/env node
import { main } from "./cli.js";
import { processIo } from "./platform.js";

process.exit(await main(process.argv.slice(2), processIo()));
