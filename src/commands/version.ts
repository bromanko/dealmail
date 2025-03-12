import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const getVersion = (): string => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const packageJsonPath = path.resolve(__dirname, "../../package.json");

    const packageJsonContent = fs.readFileSync(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);
    return packageJson.version;
  } catch (error) {
    console.error("Error reading package.json:", error);
    return "unknown";
  }
};
