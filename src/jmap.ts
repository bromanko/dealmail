import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";
import { JamClient } from "jmap-jam";

// Define more specific JMAP types for Email/set operation
export type JmapMailboxIdUpdate = {
  [mailboxId: string]: boolean | null;
};

export type JmapEmailUpdate = {
  mailboxIds: JmapMailboxIdUpdate;
};

export type JmapUpdateObject = {
  [emailId: string]: JmapEmailUpdate;
};

export type JmapEmailSetRequest = {
  accountId: string;
  update: JmapUpdateObject;
};

export type JmapEmailSetResponse = {
  accountId: string;
  updated?: { [emailId: string]: object };
  notUpdated?: { [emailId: string]: { type: string; description?: string } };
  notCreated?: { [emailId: string]: { type: string; description?: string } };
  notDestroyed?: { [emailId: string]: { type: string; description?: string } };
};

// Define types for JMAP responses
export type MailboxRole =
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

export type Mailbox = {
  id: string;
  name: string;
  role?: MailboxRole;
  totalEmails: number;
};

export type EmailAddress = {
  name?: string;
  email: string;
};

// Response type that always includes accountId and an ids array (possibly empty)
export type EmailQueryResponse = {
  accountId: string;
  ids: string[];
  total?: number;
  position?: number;
  queryState?: string;
  canCalculateChanges?: boolean;
};

// Email body part structure from JMAP
export type EmailBodyPart = {
  partId?: string;
  type?: string;
  blobId?: string;
  size?: number;
  name?: string;
  disposition?: string;
};

// The type as returned from JMAP API
export type JmapEmailData = {
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

export type EmailsDataResponse = {
  list?: readonly JmapEmailData[];
  accountId: string;
  state: string;
  notFound?: readonly string[];
};

// Base error class for JMAP operations
export class JmapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, JmapError.prototype);
  }
}

export class ApiError extends JmapError {
  cause?: Error;

  constructor(message: string, cause?: Error) {
    super(`API error: ${message}`);
    this.cause = cause;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// Validation helper
export const validateRequired = <T extends string>(
  fieldName: string,
  value: T,
): E.Either<JmapError, T> =>
  !value || value.trim() === ""
    ? E.left(new ApiError(`${fieldName} is required`))
    : E.right(value);

/**
 * Initialize JMAP client
 */
export const initializeJamClient = (
  password: string,
): TE.TaskEither<JmapError, JamClient> =>
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
export const getAccountId = (
  client: JamClient,
): TE.TaskEither<JmapError, string> =>
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
export const getMailboxes = (
  client: JamClient,
  accountId: string,
): TE.TaskEither<JmapError, ReadonlyArray<Mailbox>> =>
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
 * Find a mailbox by role
 */
export const findMailboxByRole = (
  mailboxes: ReadonlyArray<Mailbox>,
  role: MailboxRole,
): TE.TaskEither<JmapError, Mailbox> =>
  pipe(
    O.fromNullable(mailboxes.find((box: Mailbox) => box.role === role)),
    TE.fromOption(() => new ApiError(`Could not find ${role} folder`)),
    TE.map((mailbox) => {
      console.log(
        `Found ${role} folder: ${mailbox.name} with ${mailbox.totalEmails} emails`,
      );
      return mailbox;
    }),
  );

/**
 * Get emails from a specific mailbox
 */
export const getEmails = (
  client: JamClient,
  accountId: string,
  mailboxId: string,
  limit: number,
): TE.TaskEither<JmapError, EmailQueryResponse> => {
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
              inMailbox: mailboxId,
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
        console.log("No emails found in mailbox");
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
export const getEmailDetails = (
  client: JamClient,
  accountId: string,
  emailIds: string[],
): TE.TaskEither<JmapError, EmailsDataResponse> => {
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
 * Extract HTML content from email parts
 */
export const extractHtmlContent = (email: JmapEmailData): O.Option<string> => {
  // Try to get HTML content
  if (email.htmlBody && email.htmlBody.length > 0 && email.bodyValues) {
    for (const part of email.htmlBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        return O.some(email.bodyValues[part.partId].value);
      }
    }
  }
  return O.none;
};

/**
 * Extract text content from email parts
 */
export const extractTextContent = (email: JmapEmailData): O.Option<string> => {
  // Get text content
  if (email.textBody && email.textBody.length > 0 && email.bodyValues) {
    for (const part of email.textBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        return O.some(email.bodyValues[part.partId].value);
      }
    }
  }
  return O.none;
};

/**
 * Verify emails exist
 */
export const verifyEmails = (
  client: JamClient,
  accountId: string,
  emailIds: string[],
): TE.TaskEither<JmapError, string[]> =>
  pipe(
    TE.tryCatch(
      () =>
        client.request([
          "Email/get",
          {
            accountId,
            ids: emailIds,
            properties: ["id"],
          },
        ]),
      (error) =>
        new ApiError(
          `Failed to verify emails: ${error}`,
          error instanceof Error ? error : undefined,
        ),
    ),
    TE.chain(([emailsResponse]) => {
      if (emailsResponse.notFound && emailsResponse.notFound.length > 0) {
        return TE.left(
          new ApiError(
            `Some emails were not found: ${emailsResponse.notFound.join(", ")}`,
          ),
        );
      }
      return TE.right(emailIds);
    }),
  );

/**
 * Archive a single email
 */
export const archiveEmail = (
  client: JamClient,
  accountId: string,
  emailId: string,
  inboxId: string,
  archiveId: string,
): TE.TaskEither<JmapError, boolean> =>
  pipe(
    TE.tryCatch(
      () => {
        console.log(`Archiving email ${emailId}...`);
        // Create the request with our strongly typed structure
        const mailboxUpdate: JmapMailboxIdUpdate = {
          [inboxId]: null,    // Remove from inbox
          [archiveId]: true,  // Add to archive
        };
        
        const emailUpdate: JmapEmailUpdate = {
          mailboxIds: mailboxUpdate,
        };
        
        const updateObject: JmapUpdateObject = {
          [emailId]: emailUpdate,
        };
        
        const requestArgs: [string, JmapEmailSetRequest] = [
          "Email/set",
          {
            accountId,
            update: updateObject,
          },
        ];
        
        // Use as unknown to work around limited type definitions in jmap-jam
        return client.request(requestArgs as unknown as Parameters<typeof client.request>[0]);
      },
      (error) =>
        new ApiError(
          `Failed to archive email ${emailId}: ${error}`,
          error instanceof Error ? error : undefined,
        ),
    ),
    TE.chain(([response]) => {
      // Cast the response to our strongly typed response
      const emailSetResponse = response as unknown as JmapEmailSetResponse;
      
      if (
        emailSetResponse.updated && 
        Object.keys(emailSetResponse.updated).includes(emailId)
      ) {
        console.log(`Successfully archived email ${emailId}`);
        return TE.right(true);
      }
      
      if (
        emailSetResponse.notUpdated && 
        Object.keys(emailSetResponse.notUpdated).includes(emailId)
      ) {
        const error = emailSetResponse.notUpdated[emailId];
        return TE.left(
          new ApiError(
            `Failed to archive email ${emailId}: ${JSON.stringify(error)}`,
          ),
        );
      }
      
      return TE.right(false);
    }),
  );
