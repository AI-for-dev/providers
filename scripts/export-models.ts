// Writes the providers as a pi models.json, to the path given or to stdout:
//   npm run export-models -- ../trysquare-starter/models.json
import { writeFileSync } from "node:fs";
import { modelsJson } from "../extensions/index.ts";

const json = `${JSON.stringify(modelsJson(), null, 4)}\n`;
const out = process.argv[2];
if (out) writeFileSync(out, json);
else process.stdout.write(json);
