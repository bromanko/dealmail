import * as fs from "node:fs/promises";
import * as path from "node:path";
import { command, extendType, multioption, option, string } from "cmd-ts";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";
import puppeteer from "puppeteer";

class GetImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, GetImageError.prototype);
  }
}

class FileNotFoundError extends GetImageError {
  path: string;

  constructor(path: string) {
    super(`File doesn't exist: ${path}`);
    this.path = path;
    Object.setPrototypeOf(this, FileNotFoundError.prototype);
  }
}

class FileReadError extends GetImageError {
  path: string;
  cause?: Error;

  constructor(path: string, cause?: Error) {
    super(`Failed to read file: ${path}${cause ? `: ${cause.message}` : ""}`);
    this.path = path;
    this.cause = cause;
    Object.setPrototypeOf(this, FileReadError.prototype);
  }
}

class OutputDirError extends GetImageError {
  path: string;
  cause?: Error;

  constructor(path: string, cause?: Error) {
    super(
      `Failed to access output directory ${path}${cause ? `: ${cause.message}` : ""}`,
    );
    this.path = path;
    this.cause = cause;
    Object.setPrototypeOf(this, OutputDirError.prototype);
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

// Email data type as stored in JSON files
interface EmailData {
  id: string;
  subject?: string;
  from?: Array<{ name?: string; email: string }>;
  to?: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  receivedAt: string;
  htmlBody?: string;
  textBody?: string;
  bodyValues?: Record<string, { value: string; isTruncated?: boolean }>;
}

// Output directory validation
const isDirectory = (path: string): TE.TaskEither<GetImageError, string> =>
  pipe(
    TE.tryCatch(
      () => fs.stat(path),
      (error) => new FileNotFoundError(path),
    ),
    TE.chain((stats) =>
      stats.isDirectory() ? TE.right(path) : TE.left(new OutputDirError(path)),
    ),
  );

const createDirectoryIfNotExists = (
  dirPath: string,
): TE.TaskEither<GetImageError, string> =>
  pipe(
    TE.tryCatch(
      () => fs.mkdir(dirPath, { recursive: true }),
      (error) =>
        new OutputDirError(dirPath, error instanceof Error ? error : undefined),
    ),
    TE.map(() => dirPath),
  );

const OutputDirectory = extendType(string, {
  displayName: "output-dir",
  description: "Directory to save output (will be created if it doesn't exist)",
  async from(dirPath) {
    return pipe(
      dirPath,
      path.resolve,
      createDirectoryIfNotExists,
      TE.getOrElse((error) => {
        throw error;
      }),
    )();
  },
});

// File path validation
const EmailJsonPath = extendType(string, {
  displayName: "email-json-file",
  description: "Path to email JSON file",
  async from(value) {
    const filePath = path.resolve(value);
    try {
      await fs.access(filePath);
      return filePath;
    } catch (error) {
      throw new FileNotFoundError(filePath);
    }
  },
});

// Helper for multi-paths
const validatePaths = async (paths: string[]): Promise<string[]> => {
  // Check if we have at least one path
  if (paths.length === 0) {
    throw new GetImageError("At least one file path is required");
  }

  // Validate each path
  const validatedPaths: string[] = [];
  for (const path of paths) {
    const validPath = await EmailJsonPath.from(path);
    validatedPaths.push(validPath);
  }

  return validatedPaths;
};

// Multi-file path type
const EmailJsonFiles = {
  from: validatePaths,
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
 * Set the content of the page
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
 * Set viewport to a reasonable size
 */
const setViewport = (
  page: puppeteer.Page,
): TE.TaskEither<GetImageError, puppeteer.Page> =>
  TE.tryCatch(
    () => {
      page.setViewport({
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
      });
      return Promise.resolve(page);
    },
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
 * Create metadata HTML block (common across all email types)
 */
const getMetadataHtml = (email: EmailData): string => `
  <div class="email-metadata">
    <h2>${email.subject || "No Subject"}</h2>
    <p><strong>From:</strong> ${email.from ? email.from.map((addr) => addr.name || addr.email).join(", ") : "Unknown"}</p>
    <p><strong>To:</strong> ${email.to ? email.to.map((addr) => addr.name || addr.email).join(", ") : "Unknown"}</p>
    ${email.cc && email.cc.length > 0 ? `<p><strong>CC:</strong> ${email.cc.map((addr) => addr.name || addr.email).join(", ")}</p>` : ""}
    <p><strong>Date:</strong> ${new Date(email.receivedAt).toLocaleString()}</p>
  </div>
`;

/**
 * Get common styles for all templated email types
 */
const getCommonStyles = (): string => `
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .email-metadata { background: #f5f5f5; padding: 10px; margin-bottom: 20px; border-radius: 5px; }
    .email-content { padding: 10px; }
  </style>
`;

/**
 * Extract raw content (HTML or text) from email data
 */
const extractRawContent = (
  email: EmailData,
): { content: string; isHtml: boolean } => {
  // If we already have processed HTML content
  if (email.htmlBody) {
    return {
      content: email.htmlBody,
      isHtml: true,
    };
  }

  // If we already have processed text content
  if (email.textBody) {
    return {
      content: email.textBody,
      isHtml: false,
    };
  }

  // For structured data from JMAP API
  if (email.bodyValues) {
    // Find any HTML content first
    for (const key in email.bodyValues) {
      if (key.toLowerCase().includes("html")) {
        return {
          content: email.bodyValues[key].value,
          isHtml: true,
        };
      }
    }

    // Fall back to any text content
    for (const key in email.bodyValues) {
      return {
        content: email.bodyValues[key].value,
        isHtml: false,
      };
    }
  }

  // No content found
  return {
    content: "",
    isHtml: false,
  };
};

/**
 * Generate full HTML for rendering an email
 */
const generateEmailHtml = (email: EmailData): string => {
  const { content, isHtml } = extractRawContent(email);
  const metadataHtml = getMetadataHtml(email);
  const commonStyles = getCommonStyles();
  const subject = email.subject || "No Subject";

  // Special case: If email already contains full HTML document structure, use it directly
  if (
    isHtml &&
    (content.trim().toLowerCase().startsWith("<!doctype") ||
      content.trim().toLowerCase().startsWith("<html"))
  ) {
    return content;
  }

  // Create appropriate HTML based on content type
  if (content === "") {
    // No content available
    return `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${subject}</title>
        ${commonStyles}
      </head>
      <body>
        ${metadataHtml}
        <div class="email-content">
          <p>No content available for this email.</p>
        </div>
      </body>
    </html>`;
  }

  if (!isHtml) {
    // Plain text content
    return `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${subject}</title>
        ${commonStyles}
      </head>
      <body>
        ${metadataHtml}
        <div class="email-content">
          <pre style="font-family: sans-serif; white-space: pre-wrap;">${content}</pre>
        </div>
      </body>
    </html>`;
  }

  // HTML content (fragment)
  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>${subject}</title>
      ${commonStyles}
    </head>
    <body>
      ${metadataHtml}
      <div class="email-content">
        ${content}
      </div>
    </body>
  </html>`;
};

/**
 * Read email JSON file
 */
const readEmailFile = (
  filePath: string,
): TE.TaskEither<GetImageError, EmailData> =>
  pipe(
    TE.tryCatch(
      () => fs.readFile(filePath, "utf-8"),
      (error) =>
        new FileReadError(filePath, error instanceof Error ? error : undefined),
    ),
    TE.chain((content) => {
      try {
        return TE.right(JSON.parse(content) as EmailData);
      } catch (error) {
        return TE.left(
          new FileReadError(
            filePath,
            new Error(
              `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      }
    }),
  );

/**
 * Create a screenshot from an email JSON file
 */
const generateImageFromEmailFile = (
  emailFilePath: string,
  outputDir: string,
): TE.TaskEither<GetImageError, string> =>
  pipe(
    readEmailFile(emailFilePath),
    TE.chain((emailData) => {
      const emailId = emailData.id;
      const imagePath = path.join(outputDir, `email-${emailId}.png`);
      const html = generateEmailHtml(emailData);

      return pipe(
        takeScreenshot(html, imagePath),
        TE.map((filePath) => {
          console.log(
            `Generated image for ${emailId}: ${emailData.subject || "No Subject"}`,
          );
          return filePath;
        }),
      );
    }),
  );

/**
 * Process multiple email files
 */
const processEmailFiles = (
  filePaths: string[],
  outputDir: string,
): TE.TaskEither<GetImageError, number> => {
  if (filePaths.length === 0) {
    console.log("No email files to process");
    return TE.right(0);
  }

  // Process each email sequentially to avoid resource contention with browser
  const processAllFiles = filePaths.reduce(
    (acc: TE.TaskEither<GetImageError, number>, filePath) =>
      pipe(
        acc,
        TE.chain((count) =>
          pipe(
            generateImageFromEmailFile(filePath, outputDir),
            TE.map(() => count + 1),
          ),
        ),
      ),
    TE.right(0),
  );

  return processAllFiles;
};

// Get-image command definition
export const getImageCommand = command({
  name: "get-image",
  description: "Generate PNG screenshots from email JSON files",
  args: {
    files: multioption({
      type: {
        ...string,
        from: EmailJsonFiles.from,
      },
      long: "file",
      short: "f",
      description: "Path to email JSON file (can be specified multiple times)",
    }),
    outputDir: option({
      type: OutputDirectory,
      long: "output",
      short: "o",
      description: "Directory to save images (default: ./emails)",
      defaultValue: () => "./emails",
    }),
  },
  handler: async ({ files, outputDir }) => {
    console.log(`Processing ${files.length} email files...`);
    console.log(`Output directory: ${outputDir}`);

    return await pipe(
      processEmailFiles(files, outputDir),
      TE.match(
        (error) => {
          console.error("ERROR:");
          console.error(error);
          return 1; // Error exit code
        },
        (count) => {
          console.log(`Successfully generated ${count} images`);
          return 0; // Success exit code
        },
      ),
    )();
  },
});
