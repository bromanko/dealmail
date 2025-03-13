import * as fs from "node:fs/promises";
import { command, extendType, multioption, option, string } from "cmd-ts";
import {
  GoogleGenerativeAI,
  type Schema,
  SchemaType,
} from "@google/generative-ai";
import * as E from "fp-ts/lib/Either.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";

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

class FileError extends ExtractError {
  cause?: Error;
  path: string;

  constructor(path: string, message: string, cause?: Error) {
    super(`File error with ${path}: ${message}`);
    this.path = path;
    this.cause = cause;
    Object.setPrototypeOf(this, FileError.prototype);
  }
}

const PathValidator = {
  validatePaths: async (paths: string[]) => {
    if (paths.length === 0) {
      throw new ExtractError("At least one path is required");
    }

    for (const path of paths) {
      if (path.trim() === "") {
        throw new ExtractError("Path cannot be empty");
      }
    }

    return paths;
  },
};

const ImagePaths = {
  from: async (paths: string[]) => {
    return PathValidator.validatePaths(paths);
  },
};

const FilePaths = {
  from: async (paths: string[]) => {
    return PathValidator.validatePaths(paths);
  },
};

const validateApiKey = (value: string): E.Either<ExtractError, string> =>
  !value || value.trim() === ""
    ? E.left(new ApiKeyError("Gemini API key is required"))
    : E.right(value);

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
 * Define the schema for structured output from Gemini
 */
const emailInfoSchema: Schema = {
  description: "Extracted email information",
  type: SchemaType.OBJECT,
  properties: {
    sender: {
      description: "Name of the sender",
      type: SchemaType.STRING,
      nullable: false,
    },
    sales: {
      description: "List of sales",
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          description: {
            description: "Description of the sale",
            type: SchemaType.STRING,
            nullable: false,
          },
          discount: {
            description: "Discount amount or percentage",
            type: SchemaType.STRING,
            nullable: true,
          },
          endDate: {
            description: "End date of the sale",
            type: SchemaType.STRING,
            nullable: true,
          },
        },
      },
    },
    couponCodes: {
      description: "List of coupon codes",
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          code: {
            description: "Coupon code",
            type: SchemaType.STRING,
            nullable: false,
          },
          discount: {
            description: "Discount amount or percentage",
            type: SchemaType.STRING,
            nullable: true,
          },
          expirationDate: {
            description: "Expiration date of the coupon",
            type: SchemaType.STRING,
            nullable: true,
          },
        },
      },
    },
  },
  required: ["sender", "sales", "couponCodes"],
};

/**
 * Interface for the extracted deal information
 */
interface DealInfo {
  sender: string;
  sales: Array<{
    description: string;
    discount?: string;
    endDate?: string;
  }>;
  couponCodes: Array<{
    code: string;
    discount?: string;
    expirationDate?: string;
  }>;
}

/**
 * Read and parse a JSON file
 */
const readJsonFile = <T>(filePath: string): TE.TaskEither<ExtractError, T> =>
  pipe(
    TE.tryCatch(
      () => fs.readFile(filePath, "utf8"),
      (error) =>
        new FileError(
          filePath,
          `Failed to read file: ${error}`,
          error instanceof Error ? error : undefined,
        ),
    ),
    TE.chain((content) =>
      TE.tryCatch(
        () => Promise.resolve(JSON.parse(content) as T),
        (error) =>
          new FileError(
            filePath,
            `Failed to parse JSON: ${error}`,
            error instanceof Error ? error : undefined,
          ),
      ),
    ),
  );

/**
 * Write JSON data to a file
 */
const writeJsonFile = <T>(
  filePath: string,
  data: T,
): TE.TaskEither<ExtractError, void> =>
  TE.tryCatch(
    () => fs.writeFile(filePath, JSON.stringify(data, null, 2)),
    (error) =>
      new FileError(
        filePath,
        `Failed to write file: ${error}`,
        error instanceof Error ? error : undefined,
      ),
  );

/**
 * Process a single image with Gemini Vision using structured output
 */
const processImageWithGemini = (
  apiKey: string,
  imagePath: string,
): TE.TaskEither<ExtractError, DealInfo> => {
  return pipe(
    readImageAsBase64(imagePath),
    TE.chainW((base64Image) =>
      TE.tryCatch(
        async () => {
          console.log(`Processing image: ${imagePath}`);

          // Initialize the Gemini API client
          const genAI = new GoogleGenerativeAI(apiKey);

          const model = genAI.getGenerativeModel({
            model: "gemini-2.0-flash",
            systemInstruction:
              "You are an AI assistant specialized in extracting structured information from email screenshots. Focus on accurately identifying promotional deals and coupon codes.",
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: emailInfoSchema,
            },
          });

          // Prepare the image data
          const imagePart = {
            inlineData: {
              data: base64Image,
              mimeType: "image/png",
            },
          };

          // Create a detailed prompt with expected output format
          const prompt = `
            Analyze this email screenshot and extract detailed information about any promotional deals, discounts, or offers.
          `;

          // Generate content
          const result = await model.generateContent([
            { text: prompt },
            imagePart,
          ]);

          const text = result.response.text();

          try {
            return JSON.parse(text) as DealInfo;
          } catch (err) {
            throw new GeminiError(
              `Failed to parse JSON response: ${err}. Response was: ${text}`,
              err instanceof Error ? err : undefined,
            );
          }
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

/**
 * Interface to track image and file path pairs
 */
interface ImageFilePair {
  imagePath: string;
  filePath: string;
}

/**
 * Interface for the email JSON structure
 */
interface EmailJsonData {
  id: string;
  threadId: string;
  subject?: string;
  from?: Array<{ name?: string; email: string }>;
  to?: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  bcc?: Array<{ name?: string; email: string }>;
  receivedAt: string;
  sentAt?: string;
  htmlBody?: string;
  textBody?: string;
  hasAttachment?: boolean;
  dealInfo?: DealInfo;
}

const processEmailFile = (
  apiKey: string,
  pair: ImageFilePair,
): TE.TaskEither<ExtractError, void> => {
  return pipe(
    // Read the original email JSON file
    readJsonFile<EmailJsonData>(pair.filePath),
    TE.chain((emailData) =>
      pipe(
        // Process the image with Gemini
        processImageWithGemini(apiKey, pair.imagePath),
        TE.chain((dealInfo) => {
          // Update the email data with the extracted information
          const updatedEmailData = {
            ...emailData,
            dealInfo,
          };

          // Write the updated email back to the JSON file
          return writeJsonFile(pair.filePath, updatedEmailData);
        }),
      ),
    ),
  );
};

/**
 * Validate image and file path pairs have equal length
 */
const validateImageFilePairs = (
  images: string[],
  files: string[],
): E.Either<ExtractError, ImageFilePair[]> => {
  if (images.length !== files.length) {
    return E.left(
      new ExtractError(
        `Number of image paths (${images.length}) does not match number of file paths (${files.length}). Each --image must have a corresponding --file.`,
      ),
    );
  }

  const pairs: ImageFilePair[] = [];
  for (let i = 0; i < images.length; i++) {
    pairs.push({
      imagePath: images[i],
      filePath: files[i],
    });
  }

  return E.right(pairs);
};

// Extract command definition
export const extractCommand = command({
  name: "extract",
  description:
    "Extract deal information from email images and update corresponding JSON files",
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
    files: multioption({
      type: {
        ...string,
        from: FilePaths.from,
      },
      long: "file",
      short: "f",
      description:
        "Path to email JSON file to update (can be specified multiple times, must match --image count)",
    }),
    apiKey: option({
      type: ApiKey,
      long: "api-key",
      short: "k",
      description: "Google Gemini API key (fallback to GEMINI_API_KEY env var)",
      env: "GEMINI_API_KEY",
    }),
  },
  handler: async ({ images, files, apiKey }) => {
    console.log(
      `Processing ${images.length} images with corresponding JSON files...`,
    );

    // Validate image-file pairs
    const pairsEither = validateImageFilePairs(images, files);
    if (E.isLeft(pairsEither)) {
      console.error(`ERROR: ${pairsEither.left.message}`);
      return 1;
    }

    const pairs = pairsEither.right;

    // Process each image and update the corresponding file
    const processAllPairs = pipe(
      pairs.reduce(
        (acc: TE.TaskEither<ExtractError, number>, pair) =>
          pipe(
            acc,
            TE.chain((count) =>
              pipe(
                processEmailFile(apiKey, pair),
                TE.map(() => {
                  console.log(
                    `Updated file: ${pair.filePath} with extracted deal information`,
                  );
                  return count + 1;
                }),
              ),
            ),
          ),
        TE.right(0),
      ),
    );

    return await pipe(
      processAllPairs,
      TE.match(
        (error) => {
          console.error("ERROR:");
          console.error(error);
          return 1;
        },
        (count) => {
          console.log(`\nSuccessfully processed ${count} files.`);
          return 0;
        },
      ),
    )();
  },
});
