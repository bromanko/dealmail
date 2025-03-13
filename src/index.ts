import { run, subcommands } from "cmd-ts";
import { getEmailsCommand } from "./commands/get-emails.js";
import { getImageCommand } from "./commands/get-image.js";
import { extractCommand } from "./commands/extract.js";
import { getVersion } from "./commands/version.js";

const cli = subcommands({
  name: "dealmail",
  description: "Extract deal information from emails",
  version: getVersion(),
  cmds: {
    "get-emails": getEmailsCommand,
    "get-image": getImageCommand,
    "extract": extractCommand,
  },
});

run(cli, process.argv.slice(2));
