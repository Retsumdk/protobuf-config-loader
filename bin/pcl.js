#!/usr/bin/env bun
import { run } from "../src/cli-main.js";

process.exit(run(process.argv.slice(2)));
