import { run, subcommands } from "cmd-ts";
import { getEmailsCommand } from "./commands/get-emails.js";

const cli = subcommands({
  name: "dealmail",
  description: "Extract deal information from emails",
  cmds: {
    "get-emails": getEmailsCommand,
  },
});

const args = process.argv.slice(2);
if (args.length === 0) {
  // Add the help flag when no arguments are provided
  args.push("--help");
}

run(cli, args);
