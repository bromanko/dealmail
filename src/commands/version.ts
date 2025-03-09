import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

export const getVersion = async (): Promise<string> => {
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
