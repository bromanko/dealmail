import { command, flag } from "cmd-ts";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

// Private utility function to get the app version
const getVersion = async (): Promise<string> => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    
    const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);
    return packageJson.version;
  } catch (error) {
    console.error("Error reading package.json:", error);
    return "unknown";
  }
};

export const mainCommand = command({
  name: "dealmail",
  description: "Extract deal information from emails",
  args: {
    version: flag({
      long: "version",
      short: "v",
      description: "Show the application version",
    }),
  },
  handler: async ({ version }) => {
    if (version) {
      const appVersion = await getVersion();
      console.log(`dealmail v${appVersion}`);
      return;
    }

    // TODO: Implement main functionality
    console.log("Welcome to dealmail!");
  },
});