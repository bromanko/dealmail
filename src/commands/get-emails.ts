import * as fs from "node:fs/promises";
import * as path from "node:path";
import { command, extendType, option, string } from "cmd-ts";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";
import { JamClient } from "jmap-jam";

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

type EmailsDataResponse = {
  list?: readonly JmapEmailData[];
  accountId: string;
  state: string;
  notFound?: readonly string[];
};

class GetEmailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, GetEmailsError.prototype);
  }
}

class PathNotFoundError extends GetEmailsError {
  path: string;

  constructor(path: string) {
    super(`Path doesn't exist: ${path}`);
    this.path = path;
    Object.setPrototypeOf(this, PathNotFoundError.prototype);
  }
}

class NotADirectoryError extends GetEmailsError {
  path: string;

  constructor(path: string) {
    super(`Path exists but is not a directory: ${path}`);
    this.path = path;
    Object.setPrototypeOf(this, NotADirectoryError.prototype);
  }
}

class DirectoryCreationFailedError extends GetEmailsError {
  path: string;
  cause?: Error;

  constructor(path: string, cause?: Error) {
    super(
      `Failed to create directory ${path}${cause ? `: ${cause.message}` : ""}`,
    );
    this.path = path;
    this.cause = cause;
    Object.setPrototypeOf(this, DirectoryCreationFailedError.prototype);
  }
}

class ApiError extends GetEmailsError {
  cause?: Error;

  constructor(message: string, cause?: Error) {
    super(`API error: ${message}`);
    this.cause = cause;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

const isDirectory = (path: string): TE.TaskEither<GetEmailsError, string> =>
  pipe(
    TE.tryCatch(
      () => fs.stat(path),
      (err) =>
        new ApiError(
          String(err),
          err instanceof Error ? err : undefined,
        ) as GetEmailsError,
    ),
    TE.chain((stats) => {
      if (stats.isDirectory()) {
        return TE.right(path);
      }
      return TE.left<GetEmailsError, string>(new NotADirectoryError(path));
    }),
  );

const createDirectoryIfNotExists = (
  dirPath: string,
): TE.TaskEither<GetEmailsError, string> =>
  pipe(
    TE.tryCatch(
      () => fs.access(dirPath),
      () => new PathNotFoundError(dirPath),
    ),
    TE.chain(() => isDirectory(dirPath)),
    TE.orElse(() =>
      TE.tryCatch(
        () => fs.mkdir(dirPath, { recursive: true }),
        (err) =>
          new DirectoryCreationFailedError(
            dirPath,
            err instanceof Error ? err : undefined,
          ),
      ),
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

const validateRequired = <T extends string>(
  fieldName: string,
  value: T,
): E.Either<GetEmailsError, T> =>
  !value || value.trim() === ""
    ? E.left(new ApiError(`${fieldName} is required`))
    : E.right(value);

const RequiredUsername = extendType(string, {
  displayName: "username",
  description: "Fastmail username",
  async from(value) {
    return pipe(
      validateRequired("Username", value),
      E.getOrElseW((error) => {
        throw error;
      }),
    );
  },
});

const RequiredToken = extendType(string, {
  displayName: "password",
  description: "Fastmail API token/password",
  async from(value) {
    return pipe(
      validateRequired("Password/token", value),
      E.getOrElseW((error) => {
        throw error;
      }),
    );
  },
});

const parseEmailLimit = (limitStr: string): E.Either<GetEmailsError, number> =>
  pipe(
    limitStr.toLowerCase() === "all"
      ? E.right(Number.POSITIVE_INFINITY)
      : pipe(Number.parseInt(limitStr, 10), (limit) =>
          Number.isNaN(limit) || limit <= 0
            ? E.left<GetEmailsError, number>(
                new ApiError(
                  `Invalid limit: ${limitStr}. Must be a positive number or "all"`,
                ),
              )
            : E.right(limit),
        ),
  );

const EmailLimitType = extendType(string, {
  displayName: "email-limit",
  description: 'Number of emails to fetch or "all" (converted to Infinity)',
  async from(limitStr) {
    return pipe(
      parseEmailLimit(limitStr),
      E.getOrElseW((error) => {
        throw error;
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
    (error) => {
      return new ApiError(
        `Failed to initialize JMAP client: ${error}`,
        error instanceof Error ? error : undefined,
      );
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
    (error) =>
      new ApiError(
        `Failed to get account ID: ${error}`,
        error instanceof Error ? error : undefined,
      ),
  );

/**
 * Get mailboxes (folders)
 */
const getMailboxes = (
  client: JamClient,
  accountId: string,
): TE.TaskEither<GetEmailsError, ReadonlyArray<Mailbox>> =>
  pipe(
    TE.Do,
    TE.tap(() => TE.right(console.log("Fetching mailboxes..."))),
    TE.chain(() =>
      TE.tryCatch(
        () =>
          client.request([
            "Mailbox/get",
            {
              accountId,
              properties: ["id", "name", "role", "totalEmails"],
            },
          ]),
        (error) =>
          new ApiError(
            `Failed to fetch mailboxes: ${error}`,
            error instanceof Error ? error : undefined,
          ),
      ),
    ),
    TE.map(([mailboxesResponse]) => mailboxesResponse.list || []),
  );

/**
 * Find inbox in mailboxes
 */
const findInbox = (
  mailboxes: ReadonlyArray<Mailbox>,
): TE.TaskEither<GetEmailsError, Mailbox> =>
  pipe(
    O.fromNullable(mailboxes.find((box: Mailbox) => box.role === "inbox")),
    TE.fromOption(() => new ApiError("Could not find inbox folder")),
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
      () =>
        client.request([
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
      (error) =>
        new ApiError(
          `Failed to query emails: ${error}`,
          error instanceof Error ? error : undefined,
        ),
    ),
    TE.map(([emailsResponse]) => {
      // Normalize the response to ensure it has the required structure
      const normalizedResponse: EmailQueryResponse = {
        ...emailsResponse,
        accountId,
        ids: emailsResponse.ids || [], // Ensure the ids property is always an array
      };

      if (!normalizedResponse.ids.length) {
        console.log("No emails found in inbox");
      } else {
        console.log(`Found ${normalizedResponse.ids.length} emails`);
      }

      return normalizedResponse;
    }),
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
      () =>
        client.request([
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
      (error) =>
        new ApiError(
          `Failed to get email details: ${error}`,
          error instanceof Error ? error : undefined,
        ),
    ),
    TE.map(([emailsData]) => emailsData),
  );
};

/**
 * Extract raw content (HTML or text) from email parts
 */
const extractHtmlContent = (email: JmapEmailData): string | null => {
  // Try to get HTML content
  if (email.htmlBody && email.htmlBody.length > 0 && email.bodyValues) {
    for (const part of email.htmlBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        return email.bodyValues[part.partId].value;
      }
    }
  }
  return null;
};

/**
 * Extract text content from email parts
 */
const extractTextContent = (email: JmapEmailData): string | null => {
  // Get text content
  if (email.textBody && email.textBody.length > 0 && email.bodyValues) {
    for (const part of email.textBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        return email.bodyValues[part.partId].value;
      }
    }
  }
  return null;
};

/**
 * Process and extract email content for storage
 */
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

/**
 * Convert JmapEmailData to a simplified JSON format
 */
const createEmailJson = (email: JmapEmailData): EmailJson => {
  const htmlContent = extractHtmlContent(email);
  const textContent = extractTextContent(email);

  return {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    receivedAt: email.receivedAt,
    sentAt: email.sentAt,
    htmlBody: htmlContent || undefined,
    textBody: textContent || undefined,
    hasAttachment: email.hasAttachment,
  };
};

/**
 * Save email to JSON file
 */
const saveEmailToFile = (
  email: JmapEmailData,
  outputDir: string,
): TE.TaskEither<GetEmailsError, string> => {
  const emailJson = createEmailJson(email);
  const filePath = path.join(outputDir, `email-${email.id}.json`);

  return pipe(
    TE.tryCatch(
      () => fs.writeFile(filePath, JSON.stringify(emailJson, null, 2)),
      (error) =>
        new ApiError(
          `Failed to write email to file: ${error}`,
          error instanceof Error ? error : undefined,
        ),
    ),
    TE.map(() => {
      console.log(`Saved email ${email.id}: ${email.subject || "No Subject"}`);
      return filePath;
    }),
  );
};

/**
 * Process and save emails to files
 */
const processEmails = (
  emails: ReadonlyArray<JmapEmailData>,
  outputDir: string,
): TE.TaskEither<GetEmailsError, number> => {
  if (emails.length === 0) {
    console.log("No emails to process");
    return TE.right(0);
  }

  // Process each email sequentially to avoid file system race conditions
  const processAllEmails = emails.reduce(
    (acc: TE.TaskEither<GetEmailsError, number>, email) =>
      pipe(
        acc,
        TE.chain((count) =>
          pipe(
            saveEmailToFile(email, outputDir),
            TE.map(() => count + 1),
          ),
        ),
      ),
    TE.right(0),
  );

  return pipe(
    processAllEmails,
    TE.mapLeft(
      (error) =>
        new ApiError(
          `Failed to process emails: ${JSON.stringify(error, null, 2)}`,
          error instanceof Error ? error : undefined,
        ),
    ),
  );
};

/**
 * Command to fetch emails from Fastmail using JMAP API
 */
export const getEmailsCommand = command({
  name: "get-emails",
  description: "Fetch emails from Fastmail and save as JSON files",
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
      description: "Directory to save email JSON files (default: ./emails)",
      defaultValue: () => "./emails",
    }),
    limit: option({
      type: EmailLimitType,
      long: "limit",
      short: "l",
      description: 'Maximum number of emails to fetch or "all" (default: 100)',
      defaultValue: () => 100,
    }),
  },
  handler: async ({ username, password, outputDir, limit }) => {
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
        processEmails(emailsData.list || [], outputDir),
      ),
      TE.map((count) => {
        console.log(`Completed processing ${count} emails`);
        return count;
      }),
    );

    return await pipe(
      program,
      TE.match(
        (error) => {
          console.error("ERROR DETAILS:");
          console.error(error);

          console.log("Email fetch process failed");
          return 1;
        },
        (_) => {
          console.log("Email fetch process complete!");
          return 0;
        },
      ),
    )();
  },
});
