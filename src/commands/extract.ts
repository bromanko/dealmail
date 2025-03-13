import { command, extendType, multioption, string } from "cmd-ts";

// Define a base error class for the extract command
class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, ExtractError.prototype);
  }
}

// Define a custom type for arrays of image paths
const ImagePaths = {
  from: async (paths: string[]) => {
    if (paths.length === 0) {
      throw new ExtractError("At least one image path is required");
    }
    // Validate each path
    for (const path of paths) {
      if (path.trim() === "") {
        throw new ExtractError("Image path cannot be empty");
      }
    }
    return paths;
  },
};

// Extract command definition
export const extractCommand = command({
  name: "extract",
  description: "Extract deal information from email images",
  args: {
    images: multioption({
      type: {
        ...string,
        from: ImagePaths.from,
      },
      long: "image",
      short: "i",
      description: "Path to email image (can be specified multiple times)",
    }),
  },
  handler: async ({ images }) => {
    console.log("Not implemented yet");
    console.log(`Images to process: ${images.join(", ")}`);
    return 0; // Success exit code
  },
});
