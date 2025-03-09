import { command, flag } from "cmd-ts";
import { getVersion } from "./version.js";

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
