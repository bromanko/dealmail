import { run } from "cmd-ts";
import { mainCommand } from "./commands/index.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  args.push("--help");
}

run(mainCommand, args);
