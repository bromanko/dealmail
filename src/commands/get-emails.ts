import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { command, extendType, flag, option, string } from "cmd-ts";
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

type EmailQueryResponse = {
  accountId: string;
  ids?: string[];
  total?: number;
  position?: number;
};

// Simple response for when no emails are found
type NoEmailsResponse = {
  ids: never[];
  accountId: string;
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
  | { type: "PathNotFound"; path: string }
  | { type: "NotADirectory"; path: string }
  | { type: "DirectoryCreationFailed"; path: string; message: string }
  | { type: "ApiError"; message: string }
  | { type: "FileWriteError"; path: string; message: string };

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
): E.Either<GetEmailsError, number> => {
  if (limitStr.toLowerCase() === "all") {
    return E.right(Number.POSITIVE_INFINITY);
  }

  const limit = Number.parseInt(limitStr, 10);
  return Number.isNaN(limit) || limit <= 0
    ? E.left({
        type: "ApiError",
        message: `Invalid limit: ${limitStr}. Must be a positive number or "all"`,
      })
    : E.right(limit);
};

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
    (error): GetEmailsError => ({
      type: "ApiError",
      message: `Failed to initialize JMAP client: ${error}`,
    }),
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
): TE.TaskEither<GetEmailsError, EmailQueryResponse | NoEmailsResponse> =>
  TE.tryCatch(
    async () => {
      console.log("Fetching emails...");
      // Convert Infinity to undefined for API which expects a number or undefined
      const apiLimit = Number.isFinite(limit) ? limit : undefined;
      const [emailsResponse] = await client.request([
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
      ]);

      if (!emailsResponse.ids || emailsResponse.ids.length === 0) {
        console.log("No emails found in inbox");
        return { ids: [], accountId };
      }

      console.log(`Found ${emailsResponse.ids.length} emails`);
      return emailsResponse;
    },
    (error): GetEmailsError => ({
      type: "ApiError",
      message: `Failed to query emails: ${error}`,
    }),
  );

/**
 * Get detailed email data
 */
const getEmailDetails = (
  client: JamClient,
  accountId: string,
  emailIds: string[],
): TE.TaskEither<GetEmailsError, EmailsDataResponse> =>
  TE.tryCatch(
    async () => {
      if (emailIds.length === 0) return { list: [], accountId, state: "" };

      const [emailsData] = await client.request([
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
      ]);

      return emailsData;
    },
    (error): GetEmailsError => ({
      type: "ApiError",
      message: `Failed to get email details: ${error}`,
    }),
  );

/**
 * Process and save emails to files
 */
const processEmails = (
  emails: ReadonlyArray<JmapEmailData>,
  outputDir: string,
  pretty: boolean,
): TE.TaskEither<GetEmailsError, number> =>
  TE.tryCatch(
    async () => {
      if (emails.length === 0) {
        console.log("No emails to process");
        return 0;
      }

      let emailCount = 0;

      // Process emails sequentially to avoid file system race conditions
      for (const email of emails) {
        emailCount++;

        // Generate filename with timestamp and subject
        const timestamp = new Date(email.receivedAt)
          .toISOString()
          .replace(/[:.]/g, "-");
        const safeSubject = (email.subject || "No Subject")
          .replace(/[^a-z0-9]/gi, "_")
          .substring(0, 30);
        const fileName = `${emailCount}-${timestamp}-${safeSubject}.json`;
        const filePath = path.join(outputDir, fileName);

        // Email data to save
        const emailData = {
          id: email.id,
          threadId: email.threadId,
          mailboxIds: email.mailboxIds,
          from: email.from,
          to: email.to,
          cc: email.cc,
          bcc: email.bcc,
          subject: email.subject,
          receivedAt: email.receivedAt,
          sentAt: email.sentAt,
          preview: email.preview,
          hasAttachment: email.hasAttachment,
          bodyValues: email.bodyValues,
          textBody: email.textBody,
          htmlBody: email.htmlBody,
        };

        // Write to file
        await fs.writeFile(
          filePath,
          JSON.stringify(emailData, null, pretty ? 2 : 0),
          "utf8",
        );

        console.log(
          `Saved email ${emailCount}: ${email.subject || "No Subject"}`,
        );
      }

      return emailCount;
    },
    (error): GetEmailsError => ({
      type: "ApiError",
      message: `Failed to process emails: ${error}`,
    }),
  );

/**
 * Command to fetch emails from Fastmail using JMAP API
 */
export const getEmailsCommand = command({
  name: "get-emails",
  description: "Fetch emails from Fastmail using JMAP API",
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
      description: "Directory to save email data (default: ./emails)",
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
      description: "Pretty print JSON output",
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
          console.error(formatError(error));
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
