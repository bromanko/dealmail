import { run, subcommands } from "cmd-ts";
import { mainCommand } from "./commands/main.js";
import { versionCommand } from "./commands/version.js";

// Application with subcommands
const app = subcommands({
  name: "dealmail",
  description: "Extract deal information from emails",
  cmds: {
    main: mainCommand,
    version: versionCommand,
  },
});

run(app, process.argv.slice(2));
