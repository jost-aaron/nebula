#!/usr/bin/env node
import path from "node:path";
import { writeFileSync } from "node:fs";

const inputIndex = process.argv.indexOf("-i");
const inputName = path.basename(process.argv[inputIndex + 1] ?? "");
const templateIndex = process.argv.indexOf("-hls_segment_filename");
const directory = path.dirname(process.argv[templateIndex + 1]);

if (inputName.startsWith("output-limit")) writeFileSync(path.join(directory, "segment-00000.ts"), Buffer.alloc(64));
if (inputName.startsWith("segment-limit")) {
  writeFileSync(path.join(directory, "segment-00000.ts"), "one");
  writeFileSync(path.join(directory, "segment-00001.ts"), "two");
}

setInterval(() => {}, 1_000);
