import * as fs from "node:fs/promises";
import { command, extendType, multioption, option, string } from "cmd-ts";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as E from "fp-ts/lib/Either.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";

// Define a base error class for the extract command
class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, ExtractError.prototype);
  }
}

class ApiKeyError extends ExtractError {
  constructor(message: string) {
    super(`API key error: ${message}`);
    Object.setPrototypeOf(this, ApiKeyError.prototype);
  }
}

class ImageProcessingError extends ExtractError {
  cause?: Error;

  constructor(message: string, cause?: Error) {
    super(`Image processing error: ${message}`);
    this.cause = cause;
    Object.setPrototypeOf(this, ImageProcessingError.prototype);
  }
}

class GeminiError extends ExtractError {
  cause?: Error;

  constructor(message: string, cause?: Error) {
    super(`Gemini API error: ${message}`);
    this.cause = cause;
    Object.setPrototypeOf(this, GeminiError.prototype);
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

// Validate required API key
const validateApiKey = (value: string): E.Either<ExtractError, string> =>
  !value || value.trim() === ""
    ? E.left(new ApiKeyError("Gemini API key is required"))
    : E.right(value);

// Define API key type with validation
const ApiKey = extendType(string, {
  displayName: "api-key",
  description: "Google Gemini API key",
  async from(value) {
    return pipe(
      validateApiKey(value),
      E.getOrElseW((error) => {
        throw error;
      }),
    );
  },
});

/**
 * Read an image file and convert it to base64
 */
const readImageAsBase64 = (
  imagePath: string,
): TE.TaskEither<ExtractError, string> =>
  pipe(
    TE.tryCatch(
      () => fs.readFile(imagePath),
      (error) =>
        new ImageProcessingError(
          `Failed to read image file at ${imagePath}: ${error}`,
          error instanceof Error ? error : undefined,
        ),
    ),
    TE.map((buffer) => buffer.toString("base64")),
  );

/**
 * Process a single image with Gemini Vision
 */
const processImageWithGemini = (
  apiKey: string,
  imagePath: string,
): TE.TaskEither<ExtractError, string> => {
  return pipe(
    readImageAsBase64(imagePath),
    TE.chainW((base64Image) =>
      TE.tryCatch(
        async () => {
          console.log(`Processing image: ${imagePath}`);

          // Initialize the Gemini API client
          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

          // Create the prompt
          const prompt =
            "Please analyze this email screenshot and extract the following information in JSON format:\n" +
            "- Subject line\n" +
            "- Sender information\n" +
            "- Date sent\n" +
            "- Any promotional deals, discounts, or offers mentioned\n" +
            "- Coupon codes if available\n" +
            "- Expiration dates for any offers\n" +
            "- Product categories being promoted\n" +
            "- Call to action buttons or links\n\n" +
            "Format the response as valid JSON with these fields.";

          // Prepare the image data
          const imagePart = {
            inlineData: {
              data: base64Image,
              mimeType: "image/png",
            },
          };

          // Generate content
          const result = await model.generateContent([prompt, imagePart]);
          const response = await result.response;
          const text = response.text();

          return text;
        },
        (error) =>
          new GeminiError(
            `Failed to process image with Gemini: ${error}`,
            error instanceof Error ? error : undefined,
          ),
      ),
    ),
  );
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
    apiKey: option({
      type: ApiKey,
      long: "api-key",
      short: "k",
      description: "Google Gemini API key (fallback to GEMINI_API_KEY env var)",
      env: "GEMINI_API_KEY",
    }),
  },
  handler: async ({ images, apiKey }) => {
    console.log(`Processing ${images.length} images...`);

    const processImages = async () => {
      const processAllImages = pipe(
        images.reduce(
          (
            acc: TE.TaskEither<ExtractError, Record<string, string>>,
            imagePath,
          ) =>
            pipe(
              acc,
              TE.chain((currentResults) =>
                pipe(
                  processImageWithGemini(apiKey, imagePath),
                  TE.map((result) => ({
                    ...currentResults,
                    [imagePath]: result,
                  })),
                ),
              ),
            ),
          TE.right({} as Record<string, string>),
        ),
      );

      return await pipe(
        processAllImages,
        TE.match(
          (error) => {
            console.error("ERROR:");
            console.error(error);
            return 1;
          },
          (results) => {
            Object.entries(results).forEach(([imagePath, result]) => {
              console.log(`\n--- Results for ${imagePath} ---`);
              console.log(result);
            });
            return 0;
          },
        ),
      )();
    };

    return processImages();
  },
});
