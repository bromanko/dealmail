import { command, flag, run, subcommands, option, string } from "cmd-ts";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, "../package.json");

const getVersion = async (): Promise<string> => {
  try {
    const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);
    return packageJson.version;
  } catch (error) {
    console.error("Error reading package.json:", error);
    return "unknown";
  }
};

const app = subcommands({
  name: "dealmail",
  cmds: {
    // Main app command
    app: command({
      name: "dealmail",
      description: "Extract deal information from emails",
      args: {},
      flags: {
        version: flag({
          type: string,
          long: "version",
          short: "v",
          description: "Show the application version",
        }),
      },
      handler: async ({ version }) => {
        if (version !== undefined) {
          const appVersion = await getVersion();
          console.log(`dealmail v${appVersion}`);
          return;
        }

        // TODO: Implement main functionality
        console.log("Welcome to dealmail!");
      },
    }),
  },
  defaultCmd: "app",
});

run(app, process.argv.slice(2));
