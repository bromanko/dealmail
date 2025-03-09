import { command } from "cmd-ts";

export const mainCommand = command({
  name: "main",
  description: "Extract deal information from emails",
  args: {},
  handler: async () => {
    // TODO: Implement main functionality
    console.log("Welcome to dealmail!");
  },
});