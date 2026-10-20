import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCast, pressCorpsFromCast } from "../packages/press/src/index.js";

/** Regenerates agent cards and the press-corps card from creators/<id>/press/cast.json. Run after editing the cast. */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const creator = process.argv[2] ?? "leo";
const dir = join(repo, "creators", creator, "press");
const corps = pressCorpsFromCast(loadCast(join(dir, "cast.json")));
mkdirSync(join(dir, "agents"), { recursive: true });
for (const card of corps.reporters) writeFileSync(join(dir, "agents", `${card.id}.agent.json`), JSON.stringify(card, null, 2) + "\n");
writeFileSync(join(dir, "press-corps.json"), JSON.stringify(corps, null, 2) + "\n");
console.log(`${corps.reporters.length} agent cards + press-corps.json → ${dir}`);
