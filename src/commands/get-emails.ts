import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { command, extendType, flag, option, string } from "cmd-ts";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";
import { JamClient } from "jmap-jam";
import puppeteer from "puppeteer";

// Define types for JMAP responses
type MailboxRole =
  | "inbox"
  | "archive"
  | "drafts"
  | "flagged"
  | "important"
  | "junk"
  | "sent"
  | "subscribed"
  | "trash"
  | "all"
  | null
  | undefined;

type Mailbox = {
  id: string;
  name: string;
  role?: MailboxRole;
  totalEmails: number;
};

type EmailAddress = {
  name?: string;
  email: string;
};


// Response type that always includes accountId and an ids array (possibly empty)
type EmailQueryResponse = {
  accountId: string;
  ids: string[];
  total?: number;
  position?: number;
  queryState?: string;
  canCalculateChanges?: boolean;
};

// Email body part structure from JMAP
type EmailBodyPart = {
  partId?: string;
  type?: string;
  blobId?: string;
  size?: number;
  name?: string;
  disposition?: string;
};

// The type as returned from JMAP API
type JmapEmailData = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject?: string; // Actually can be undefined in API response
  receivedAt: string;
  sentAt?: string;
  preview?: string;
  hasAttachment?: boolean;
  bodyValues?: Record<string, { value: string; isTruncated?: boolean }>;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
};

// Our stricter type for processing
type EmailData = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string; // We ensure this is defined
  receivedAt: string;
  sentAt?: string;
  preview?: string;
  hasAttachment?: boolean;
  bodyValues?: Record<string, { value: string; isTruncated?: boolean }>;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
};

type EmailsDataResponse = {
  list?: readonly JmapEmailData[];
  accountId: string;
  state: string;
  notFound?: readonly string[];
};

type GetEmailsError =
  | { type: "PathNotFound"; path: string; stack?: string }
  | { type: "NotADirectory"; path: string; stack?: string }
  | { type: "DirectoryCreationFailed"; path: string; message: string; stack?: string }
  | { type: "ApiError"; message: string; stack?: string }
  | { type: "FileWriteError"; path: string; message: string; stack?: string }
  | { type: "ScreenshotError"; message: string; stack?: string };

const formatError = (error: GetEmailsError): string => {
  switch (error.type) {
    case "PathNotFound":
      return `Path doesn't exist: ${error.path}`;
    case "NotADirectory":
      return `Path exists but is not a directory: ${error.path}`;
    case "DirectoryCreationFailed":
      return `Failed to create directory ${error.path}: ${error.message}`;
    case "ApiError":
      return `API error: ${error.message}`;
    case "FileWriteError":
      return `Failed to write file ${error.path}: ${error.message}`;
    case "ScreenshotError":
      return `Failed to generate screenshot: ${error.message}`;
  }
};

const ExistingPath = extendType(string, {
  displayName: "path",
  description: "An existing path",
  async from(str) {
    const resolved = path.resolve(str);

    return pipe(
      TE.tryCatch(
        () => fs.access(resolved, constants.F_OK),
        () => ({ type: "PathNotFound", path: resolved }) as GetEmailsError,
      ),
      TE.map(() => resolved),
      TE.getOrElse((error) => {
        throw new Error(formatError(error));
      }),
    )();
  },
});

// Check if a path is a directory
const isDirectory = (path: string): TE.TaskEither<GetEmailsError, string> =>
  pipe(
    TE.tryCatch(
      () => fs.stat(path),
      (err): GetEmailsError => ({ type: "ApiError", message: String(err) }),
    ),
    TE.chain((stats) =>
      stats.isDirectory()
        ? TE.right(path)
        : TE.left({ type: "NotADirectory", path }),
    ),
  );

// Create a directory if it doesn't exist
const createDirectoryIfNotExists = (
  dirPath: string,
): TE.TaskEither<GetEmailsError, string> =>
  pipe(
    TE.tryCatch(
      () => fs.access(dirPath),
      () => ({ type: "PathNotFound", path: dirPath }) as GetEmailsError,
    ),
    TE.chain(() => isDirectory(dirPath)),
    TE.orElse(() =>
      TE.tryCatch(
        () => fs.mkdir(dirPath, { recursive: true }),
        (err): GetEmailsError => ({
          type: "DirectoryCreationFailed",
          path: dirPath,
          message: String(err),
        }),
      ),
    ),
    TE.map(() => dirPath),
  );

// Output directory validator
const OutputDirectory = extendType(string, {
  displayName: "output-dir",
  description: "Directory to save output (will be created if it doesn't exist)",
  async from(dirPath) {
    const resolved = path.resolve(dirPath);

    return pipe(
      createDirectoryIfNotExists(resolved),
      TE.getOrElse((error) => {
        throw new Error(formatError(error));
      }),
    )();
  },
});

// Validate required string values
const validateRequired = <T extends string>(
  fieldName: string,
  value: T,
): E.Either<GetEmailsError, T> =>
  !value || value.trim() === ""
    ? E.left({ type: "ApiError", message: `${fieldName} is required` })
    : E.right(value);

// Username validator
const RequiredUsername = extendType(string, {
  displayName: "username",
  description: "Fastmail username",
  async from(value) {
    return pipe(
      validateRequired("Username", value),
      E.getOrElseW((error) => {
        throw new Error(formatError(error));
      }),
    );
  },
});

// Password/token validator
const RequiredToken = extendType(string, {
  displayName: "password",
  description: "Fastmail API token/password",
  async from(value) {
    return pipe(
      validateRequired("Password/token", value),
      E.getOrElseW((error) => {
        throw new Error(formatError(error));
      }),
    );
  },
});

// Parse a string to number (including "all" as Infinity)
const parseEmailLimit = (
  limitStr: string,
): E.Either<GetEmailsError, number> => 
  pipe(
    limitStr.toLowerCase() === "all"
      ? E.right(Number.POSITIVE_INFINITY)
      : pipe(
          Number.parseInt(limitStr, 10),
          (limit) => 
            Number.isNaN(limit) || limit <= 0
              ? E.left<GetEmailsError, number>({
                  type: "ApiError",
                  message: `Invalid limit: ${limitStr}. Must be a positive number or "all"`,
                })
              : E.right(limit)
        )
  );

// Functional validation for email limit that returns a number
const EmailLimitType = extendType(string, {
  displayName: "email-limit",
  description: 'Number of emails to fetch or "all" (converted to Infinity)',
  async from(limitStr) {
    return pipe(
      parseEmailLimit(limitStr),
      E.getOrElseW((error) => {
        throw new Error(formatError(error));
      }),
    );
  },
});

/**
 * Initialize JMAP client
 */
const initializeJamClient = (
  password: string,
): TE.TaskEither<GetEmailsError, JamClient> =>
  TE.tryCatch(
    () => {
      console.log("Initializing JMAP client...");
      return Promise.resolve(
        new JamClient({
          sessionUrl: "https://api.fastmail.com/jmap/session",
          bearerToken: password,
        }),
      );
    },
    (error): GetEmailsError => {
      const errorObj: GetEmailsError = {
        type: "ApiError",
        message: `Failed to initialize JMAP client: ${error}`,
      };
      
      if (error instanceof Error && error.stack) {
        errorObj.stack = error.stack;
      }
      
      return errorObj;
    },
  );

/**
 * Get primary account ID
 */
const getAccountId = (
  client: JamClient,
): TE.TaskEither<GetEmailsError, string> =>
  TE.tryCatch(
    () => {
      console.log("Getting account ID...");
      return client.getPrimaryAccount();
    },
    (error): GetEmailsError => ({
      type: "ApiError",
      message: `Failed to get account ID: ${error}`,
    }),
  );

/**
 * Get mailboxes (folders)
 */
const getMailboxes = (
  client: JamClient,
  accountId: string,
): TE.TaskEither<GetEmailsError, ReadonlyArray<Mailbox>> =>
  TE.tryCatch(
    async () => {
      console.log("Fetching mailboxes...");
      const [mailboxesResponse] = await client.request([
        "Mailbox/get",
        {
          accountId,
          properties: ["id", "name", "role", "totalEmails"],
        },
      ]);
      return mailboxesResponse.list || [];
    },
    (error): GetEmailsError => ({
      type: "ApiError",
      message: `Failed to fetch mailboxes: ${error}`,
    }),
  );

/**
 * Find inbox in mailboxes
 */
const findInbox = (
  mailboxes: ReadonlyArray<Mailbox>,
): TE.TaskEither<GetEmailsError, Mailbox> =>
  pipe(
    O.fromNullable(mailboxes.find((box: Mailbox) => box.role === "inbox")),
    TE.fromOption(
      (): GetEmailsError => ({
        type: "ApiError",
        message: "Could not find inbox folder",
      }),
    ),
    TE.map((inbox) => {
      console.log(
        `Found inbox: ${inbox.name} with ${inbox.totalEmails} emails`,
      );
      return inbox;
    }),
  );

/**
 * Get emails from inbox
 */
const getEmails = (
  client: JamClient,
  accountId: string,
  inboxId: string,
  limit: number,
): TE.TaskEither<GetEmailsError, EmailQueryResponse> => {
  console.log("Fetching emails...");
  
  // Convert Infinity to undefined for API which expects a number or undefined
  const apiLimit = Number.isFinite(limit) ? limit : undefined;
  
  return pipe(
    TE.tryCatch(
      () => client.request([
        "Email/query",
        {
          accountId,
          filter: {
            inMailbox: inboxId,
          },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: apiLimit,
          calculateTotal: true,
        },
      ]),
      (error): GetEmailsError => ({
        type: "ApiError",
        message: `Failed to query emails: ${error}`,
      })
    ),
    TE.map(([emailsResponse]) => {
      // Normalize the response to ensure it has the required structure
      const normalizedResponse: EmailQueryResponse = {
        ...emailsResponse,
        accountId,
        ids: emailsResponse.ids || [] // Ensure the ids property is always an array
      };
      
      if (!normalizedResponse.ids.length) {
        console.log("No emails found in inbox");
      } else {
        console.log(`Found ${normalizedResponse.ids.length} emails`);
      }
      
      return normalizedResponse;
    })
  );
};

/**
 * Get detailed email data
 */
const getEmailDetails = (
  client: JamClient,
  accountId: string,
  emailIds: string[],
): TE.TaskEither<GetEmailsError, EmailsDataResponse> => {
  if (emailIds.length === 0) {
    return TE.right({ list: [], accountId, state: "" });
  }

  return pipe(
    TE.tryCatch(
      () => client.request([
        "Email/get",
        {
          accountId,
          ids: emailIds,
          properties: [
            "id",
            "threadId",
            "mailboxIds",
            "keywords",
            "from",
            "to",
            "cc",
            "bcc",
            "subject",
            "receivedAt",
            "sentAt",
            "preview",
            "hasAttachment",
            "bodyValues",
            "textBody",
            "htmlBody",
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        },
      ]),
      (error): GetEmailsError => ({
        type: "ApiError",
        message: `Failed to get email details: ${error}`,
      })
    ),
    TE.map(([emailsData]) => emailsData)
  );
};

// Convert a single email to a screenshot
const saveEmailToFile = (
  email: JmapEmailData,
  index: number,
  outputDir: string,
  pretty: boolean
): TE.TaskEither<GetEmailsError, string> => {
  // Generate filename with timestamp and subject
  const timestamp = new Date(email.receivedAt)
    .toISOString()
    .replace(/[:.]/g, "-");
  const safeSubject = (email.subject || "No Subject")
    .replace(/[^a-z0-9]/gi, "_")
    .substring(0, 30);
  const fileName = `${index}-${timestamp}-${safeSubject}.png`;
  const filePath = path.join(outputDir, fileName);

  // Extract HTML content from email
  const getHtmlContent = (): string => {
    // Look for HTML body content in bodyValues
    if (email.htmlBody && email.htmlBody.length > 0 && email.bodyValues) {
      for (const part of email.htmlBody) {
        if (part.partId && email.bodyValues[part.partId]) {
          return email.bodyValues[part.partId].value;
        }
      }
    }
    
    // Fallback to creating HTML from text body if HTML isn't available
    if (email.textBody && email.textBody.length > 0 && email.bodyValues) {
      for (const part of email.textBody) {
        if (part.partId && email.bodyValues[part.partId]) {
          const text = email.bodyValues[part.partId].value;
          // Convert plain text to simple HTML
          return `<!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>${email.subject || "No Subject"}</title>
            </head>
            <body>
              <pre style="font-family: sans-serif; white-space: pre-wrap;">${text}</pre>
            </body>
          </html>`;
        }
      }
    }
    
    // Final fallback for when no content is available
    return `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${email.subject || "No Subject"}</title>
      </head>
      <body>
        <h1>${email.subject || "No Subject"}</h1>
        <p>From: ${email.from ? email.from.map(addr => addr.name || addr.email).join(", ") : "Unknown"}</p>
        <p>Date: ${new Date(email.receivedAt).toLocaleString()}</p>
        <p>No content available for this email.</p>
      </body>
    </html>`;
  };

  // Generate full HTML with proper styling and metadata
  const generateFullHtml = (): string => {
    const htmlContent = getHtmlContent();
    
    // If the content already has HTML structure, return it as is
    if (htmlContent.trim().toLowerCase().startsWith("<!doctype") || 
        htmlContent.trim().toLowerCase().startsWith("<html")) {
      return htmlContent;
    }
    
    // Otherwise wrap it in proper HTML structure
    return `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${email.subject || "No Subject"}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .email-metadata { background: #f5f5f5; padding: 10px; margin-bottom: 20px; border-radius: 5px; }
          .email-content { padding: 10px; }
        </style>
      </head>
      <body>
        <div class="email-metadata">
          <h2>${email.subject || "No Subject"}</h2>
          <p><strong>From:</strong> ${email.from ? email.from.map(addr => addr.name || addr.email).join(", ") : "Unknown"}</p>
          <p><strong>To:</strong> ${email.to ? email.to.map(addr => addr.name || addr.email).join(", ") : "Unknown"}</p>
          ${email.cc && email.cc.length > 0 ? `<p><strong>CC:</strong> ${email.cc.map(addr => addr.name || addr.email).join(", ")}</p>` : ""}
          <p><strong>Date:</strong> ${new Date(email.receivedAt).toLocaleString()}</p>
        </div>
        <div class="email-content">
          ${htmlContent}
        </div>
      </body>
    </html>`;
  };

  return pipe(
    TE.tryCatch(
      async () => {
        const html = generateFullHtml();
        
        // Launch puppeteer browser
        const browser = await puppeteer.launch({
          headless: true,
        });
        
        try {
          const page = await browser.newPage();
          
          // Set content and wait for it to load
          await page.setContent(html, { waitUntil: "networkidle0" });
          
          // Make sure to size the viewport appropriately
          await page.setViewport({ width: 1200, height: 800 });
          
          // Take screenshot of the full page
          await page.screenshot({
            path: filePath,
            fullPage: true,
            type: "png",
          });
          
          return filePath;
        } finally {
          await browser.close();
        }
      },
      (error): GetEmailsError => {
        // Capture stack trace for better debugging
        const errorObj: GetEmailsError & { stack?: string } = {
          type: "ScreenshotError",
          message: String(error),
        };
        
        // Keep the stack trace if it exists
        if (error instanceof Error && error.stack) {
          errorObj.stack = error.stack;
        }
        
        return errorObj;
      }
    ),
    TE.map((path) => {
      console.log(`Saved screenshot ${index}: ${email.subject || "No Subject"}`);
      return path;
    })
  );
};

/**
 * Process and save emails to files
 */
const processEmails = (
  emails: ReadonlyArray<JmapEmailData>,
  outputDir: string,
  pretty: boolean,
): TE.TaskEither<GetEmailsError, number> => {
  if (emails.length === 0) {
    console.log("No emails to process");
    return TE.right(0);
  }

  // Process each email sequentially to avoid file system race conditions
  const processAllEmails = emails.reduce(
    (acc: TE.TaskEither<GetEmailsError, number>, email, index) => 
      pipe(
        acc,
        TE.chain(count => 
          pipe(
            saveEmailToFile(email, count + 1, outputDir, pretty),
            TE.map(() => count + 1)
          )
        )
      ),
    TE.right(0)
  );

  return pipe(
    processAllEmails,
    TE.mapLeft((error): GetEmailsError => {
      if (error.type) {
        return error;
      }
      return {
        type: "ApiError",
        message: `Failed to process emails: ${JSON.stringify(error, null, 2)}`,
      };
    })
  );
};

/**
 * Command to fetch emails from Fastmail using JMAP API
 */
export const getEmailsCommand = command({
  name: "get-emails",
  description: "Fetch emails from Fastmail and save as PNG screenshots",
  args: {
    username: option({
      type: RequiredUsername,
      long: "username",
      short: "u",
      description: "Fastmail username (fallback to FASTMAIL_USERNAME env var)",
      env: "FASTMAIL_USERNAME",
    }),
    password: option({
      type: RequiredToken,
      long: "password",
      short: "p",
      description:
        "Fastmail API token/password (fallback to FASTMAIL_PASSWORD env var)",
      env: "FASTMAIL_PASSWORD",
    }),
    outputDir: option({
      type: OutputDirectory,
      long: "output",
      short: "o",
      description: "Directory to save email screenshots (default: ./emails)",
      defaultValue: () => "./emails",
    }),
    limit: option({
      type: EmailLimitType,
      long: "limit",
      short: "l",
      description: 'Maximum number of emails to fetch or "all" (default: 100)',
      defaultValue: () => 100,
    }),
    pretty: flag({
      long: "pretty",
      description: "Deprecated - kept for compatibility",
    }),
  },
  handler: async ({ username, password, outputDir, limit, pretty }) => {
    console.log("Starting email fetch process...");
    console.log(`Connecting to Fastmail as ${username}`);
    console.log(`Output directory: ${outputDir}`);
    console.log(`Email limit: ${limit}`);

    // Main program flow using fp-ts with flattened structure
    const program = pipe(
      initializeJamClient(password),
      TE.chain((client) =>
        pipe(
          getAccountId(client),
          TE.map((accountId) => ({ client, accountId })),
        ),
      ),
      TE.chain(({ client, accountId }) =>
        pipe(
          getMailboxes(client, accountId),
          TE.map((mailboxes) => ({ client, accountId, mailboxes })),
        ),
      ),
      TE.chain(({ client, accountId, mailboxes }) =>
        pipe(
          findInbox(mailboxes),
          TE.map((inbox) => ({ client, accountId, inbox })),
        ),
      ),
      TE.chain(({ client, accountId, inbox }) =>
        pipe(
          getEmails(client, accountId, inbox.id, limit),
          TE.map((emailsResponse) => ({ client, accountId, emailsResponse })),
        ),
      ),
      TE.chain(({ client, accountId, emailsResponse }) =>
        pipe(
          getEmailDetails(client, accountId, emailsResponse.ids || []),
          TE.map((emailsData) => ({ emailsData })),
        ),
      ),
      TE.chain(({ emailsData }) =>
        processEmails(emailsData.list || [], outputDir, pretty),
      ),
      TE.map((count) => {
        console.log(`Completed processing ${count} emails`);
        return count;
      }),
    );

    // Execute the program
    return await pipe(
      program,
      TE.match(
        (error) => {
          console.error("ERROR DETAILS:");
          console.error(formatError(error));
          if (error.type === "ScreenshotError" || error.type === "ApiError") {
            console.error("Full error object:");
            console.error(JSON.stringify(error, null, 2));
            console.error("Stack trace if available:");
            if (error.stack) {
              console.error(error.stack);
            } else if (error.message && error.message.includes("Error:")) {
              // Try to extract stack trace from error message
              console.error(error.message);
            }
          }
          console.log("Email fetch process failed");
          return 1; // Error exit code
        },
        (_) => {
          console.log("Email fetch process complete!");
          return 0; // Success exit code
        },
      ),
    )();
  },
});
