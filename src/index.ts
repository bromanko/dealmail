import { run } from "cmd-ts";
import { mainCommand } from "./commands/index.js";

// Run the main command directly
run(mainCommand, process.argv.slice(2));
