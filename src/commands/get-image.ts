import * as fs from "node:fs/promises";
import * as path from "node:path";
import { command, extendType, multioption, option, string } from "cmd-ts";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";
import puppeteer from "puppeteer";
import {
  FilesystemError,
  OutputDirectory,
  FileError,
  readJsonFile,
} from "../filesystem.js";

class GetImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, GetImageError.prototype);
  }
}

class ScreenshotError extends GetImageError {
  cause?: Error;

  constructor(message: string, cause?: Error) {
    super(`Failed to generate screenshot: ${message}`);
    this.cause = cause;
    Object.setPrototypeOf(this, ScreenshotError.prototype);
  }
}

interface EmailJson {
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
}

type EmailJsonPath = string;

// Custom type for validating email JSON file paths
const EmailJsonPaths = {
  from: async (paths: string[]) => {
    if (paths.length === 0) {
      throw new GetImageError("At least one email JSON file path is required");
    }

    for (const path of paths) {
      try {
        await fs.access(path);
      } catch (error) {
        throw new GetImageError(`File not found: ${path}`);
      }
    }

    return paths;
  },
};

// Validate that paths exist and are readable
const validatePaths = (
  paths: EmailJsonPath[],
): TE.TaskEither<GetImageError, ReadonlyArray<EmailJsonPath>> => {
  const validatePath = (
    path: EmailJsonPath,
  ): TE.TaskEither<GetImageError, EmailJsonPath> =>
    pipe(
      TE.tryCatch(
        () => fs.access(path),
        () => new GetImageError(`File doesn't exist: ${path}`),
      ),
      TE.map(() => path),
    );

  // Validate each path and collect results
  return TE.sequenceArray(paths.map(validatePath));
};

/**
 * Launch puppeteer browser
 */
const launchBrowser = (): TE.TaskEither<GetImageError, puppeteer.Browser> =>
  TE.tryCatch(
    () => puppeteer.launch({ headless: true }),
    (error) =>
      new ScreenshotError(
        `Failed to launch browser: ${error}`,
        error instanceof Error ? error : undefined,
      ),
  );

/**
 * Create a new page in the browser
 */
const createPage = (
  browser: puppeteer.Browser,
): TE.TaskEither<GetImageError, puppeteer.Page> =>
  TE.tryCatch(
    () => browser.newPage(),
    (error) =>
      new ScreenshotError(
        `Failed to create page: ${error}`,
        error instanceof Error ? error : undefined,
      ),
  );

/**
 * Set HTML content in the page
 */
const setPageContent = (
  page: puppeteer.Page,
  html: string,
): TE.TaskEither<GetImageError, puppeteer.Page> =>
  TE.tryCatch(
    () => page.setContent(html, { waitUntil: "networkidle0" }).then(() => page),
    (error) =>
      new ScreenshotError(
        `Failed to set page content: ${error}`,
        error instanceof Error ? error : undefined,
      ),
  );

/**
 * Set viewport size
 */
const setViewport = (
  page: puppeteer.Page,
): TE.TaskEither<GetImageError, puppeteer.Page> =>
  TE.tryCatch(
    () => page.setViewport({ width: 1200, height: 800 }).then(() => page),
    (error) =>
      new ScreenshotError(
        `Failed to set viewport: ${error}`,
        error instanceof Error ? error : undefined,
      ),
  );

/**
 * Take screenshot and save to file
 */
const captureScreenshot = (
  page: puppeteer.Page,
  filePath: string,
): TE.TaskEither<GetImageError, string> =>
  TE.tryCatch(
    () =>
      page
        .screenshot({
          path: filePath,
          fullPage: true,
          type: "png",
        })
        .then(() => filePath),
    (error) =>
      new ScreenshotError(
        `Failed to capture screenshot: ${error}`,
        error instanceof Error ? error : undefined,
      ),
  );

/**
 * Close browser
 */
const closeBrowser = (
  browser: puppeteer.Browser,
): TE.TaskEither<GetImageError, void> =>
  TE.tryCatch(
    () => browser.close(),
    (error) =>
      new ScreenshotError(
        `Failed to close browser: ${error}`,
        error instanceof Error ? error : undefined,
      ),
  );

/**
 * Take a screenshot using Puppeteer with a fully functional approach
 */
const takeScreenshot = (
  html: string,
  filePath: string,
): TE.TaskEither<GetImageError, string> =>
  pipe(
    launchBrowser(),
    TE.chain((browser) =>
      pipe(
        createPage(browser),
        TE.chain((page) =>
          pipe(
            setPageContent(page, html),
            TE.chain(setViewport),
            TE.chain((configuredPage) =>
              captureScreenshot(configuredPage, filePath),
            ),
            TE.chainFirst(() => closeBrowser(browser)),
            TE.orElse((error) =>
              pipe(
                TE.tryCatch(
                  () => browser.close(),
                  () => error, // Preserve original error
                ),
                TE.chain(() => TE.left(error)), // Re-throw original error
              ),
            ),
          ),
        ),
      ),
    ),
  );

/**
 * Process an email JSON file to generate a screenshot
 */
const processEmailFile = (
  inputPath: EmailJsonPath,
  outputDir: string,
): TE.TaskEither<GetImageError, string> =>
  pipe(
    readJsonFile<EmailJson>(inputPath),
    TE.mapLeft(
      (error) =>
        new GetImageError(
          `Failed to read or parse email JSON file: ${error.message}`,
        ),
    ),
    TE.chain((emailData) => {
      if (!emailData.htmlBody) {
        return TE.left(
          new GetImageError(`Email JSON file has no HTML content: ${inputPath}`),
        );
      }

      const outputFileName = `${path.basename(
        inputPath,
        path.extname(inputPath),
      )}.png`;
      const outputPath = path.join(outputDir, outputFileName);

      return pipe(
        takeScreenshot(emailData.htmlBody, outputPath),
        TE.tap(() =>
          TE.right(
            console.log(
              `Generated screenshot for email: ${
                emailData.subject || "No Subject"
              }`,
            ),
          ),
        ),
      );
    }),
  );

/**
 * Process multiple email JSON files to generate screenshots
 */
const processEmailFiles = (
  inputPaths: ReadonlyArray<EmailJsonPath>,
  outputDir: string,
): TE.TaskEither<GetImageError, number> => {
  if (inputPaths.length === 0) {
    console.log("No email files to process");
    return TE.right(0);
  }

  // Process each file sequentially
  const processAllFiles = inputPaths.reduce(
    (acc: TE.TaskEither<GetImageError, number>, inputPath) =>
      pipe(
        acc,
        TE.chain((count) =>
          pipe(
            processEmailFile(inputPath, outputDir),
            TE.map(() => count + 1),
            TE.orElse((error) => {
              console.error(
                `Error processing ${inputPath}: ${error.message}. Continuing with next file.`,
              );
              return TE.right(count);
            }),
          ),
        ),
      ),
    TE.right(0),
  );

  return processAllFiles;
};

// Command definition
export const getImageCommand = command({
  name: "get-image",
  description: "Generate PNG screenshots from email JSON files",
  args: {
    inputs: multioption({
      type: {
        ...string,
        from: EmailJsonPaths.from,
      },
      long: "input",
      short: "i",
      description: "Path to email JSON file (can be specified multiple times)",
    }),
    outputDir: option({
      type: OutputDirectory,
      long: "output",
      short: "o",
      description: "Directory to save screenshots (default: ./screenshots)",
      defaultValue: () => "./screenshots",
    }),
  },
  handler: async ({ inputs, outputDir }) => {
    console.log(`Processing ${inputs.length} email files...`);
    console.log(`Output directory: ${outputDir}`);

    // Main program flow
    const program = pipe(
      validatePaths(inputs),
      TE.chain((validatedPaths) => processEmailFiles(validatedPaths, outputDir)),
      TE.map((count) => {
        console.log(`Successfully generated ${count} screenshots`);
        return count;
      }),
    );

    return await pipe(
      program,
      TE.match(
        (error) => {
          console.error("ERROR:");
          console.error(error);
          return 1;
        },
        (_) => {
          console.log("Process complete!");
          return 0;
        },
      ),
    )();
  },
});