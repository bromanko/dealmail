import { command, extendType, multioption, option, string } from "cmd-ts";
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

// Define base error class
class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, ArchiveError.prototype);
  }
}

class ApiError extends ArchiveError {
  cause?: Error;

  constructor(message: string, cause?: Error) {
    super(`API error: ${message}`);
    this.cause = cause;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

const validateRequired = <T extends string>(
  fieldName: string,
  value: T,
): E.Either<ArchiveError, T> =>
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

// Validate email IDs
const EmailIds = {
  from: async (ids: string[]) => {
    if (ids.length === 0) {
      throw new ArchiveError("At least one email ID is required");
    }

    for (const id of ids) {
      if (id.trim() === "") {
        throw new ArchiveError("Email ID cannot be empty");
      }
    }

    return ids;
  },
};

/**
 * Initialize JMAP client
 */
const initializeJamClient = (
  password: string,
): TE.TaskEither<ArchiveError, JamClient> =>
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
const getAccountId = (client: JamClient): TE.TaskEither<ArchiveError, string> =>
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
): TE.TaskEither<ArchiveError, ReadonlyArray<Mailbox>> =>
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
 * Find archive mailbox
 */
const findArchiveMailbox = (
  mailboxes: ReadonlyArray<Mailbox>,
): TE.TaskEither<ArchiveError, Mailbox> =>
  pipe(
    O.fromNullable(mailboxes.find((box: Mailbox) => box.role === "archive")),
    TE.fromOption(() => new ApiError("Could not find archive folder")),
    TE.map((archive) => {
      console.log(
        `Found archive folder: ${archive.name} with ${archive.totalEmails} emails`,
      );
      return archive;
    }),
  );

/**
 * Find inbox mailbox
 */
const findInboxMailbox = (
  mailboxes: ReadonlyArray<Mailbox>,
): TE.TaskEither<ArchiveError, Mailbox> =>
  pipe(
    O.fromNullable(mailboxes.find((box: Mailbox) => box.role === "inbox")),
    TE.fromOption(() => new ApiError("Could not find inbox folder")),
    TE.map((inbox) => {
      console.log(
        `Found inbox folder: ${inbox.name} with ${inbox.totalEmails} emails`,
      );
      return inbox;
    }),
  );

/**
 * Verify emails exist
 */
const verifyEmails = (
  client: JamClient,
  accountId: string,
  emailIds: string[],
): TE.TaskEither<ArchiveError, string[]> =>
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
const archiveEmail = (
  client: JamClient,
  accountId: string,
  emailId: string,
  inboxId: string,
  archiveId: string,
): TE.TaskEither<ArchiveError, boolean> =>
  pipe(
    TE.tryCatch(
      () => {
        console.log(`Archiving email ${emailId}...`);
        // Use any type for now to avoid type issues with jmap-jam
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const requestArgs: any = [
          "Email/set",
          {
            accountId,
            update: {
              [emailId]: {
                mailboxIds: {
                  [inboxId]: null, // Remove from inbox
                  [archiveId]: true, // Add to archive
                },
              },
            },
          },
        ];
        return client.request(requestArgs);
      },
      (error) =>
        new ApiError(
          `Failed to archive email ${emailId}: ${error}`,
          error instanceof Error ? error : undefined,
        ),
    ),
    TE.chain(([response]) => {
      // Cast the response to a generic type to access the properties
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const emailSetResponse = response as any;

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

/**
 * Archive multiple emails - moves from inbox to archive folder
 */
const archiveEmails = (
  client: JamClient,
  accountId: string,
  emailIds: string[],
  inboxId: string,
  archiveId: string,
): TE.TaskEither<ArchiveError, number> => {
  console.log(`Archiving ${emailIds.length} emails...`);

  // Process each email sequentially to avoid potential race conditions
  const processAllEmails = emailIds.reduce(
    (acc: TE.TaskEither<ArchiveError, number>, emailId) =>
      pipe(
        acc,
        TE.chain((count) =>
          pipe(
            archiveEmail(client, accountId, emailId, inboxId, archiveId),
            TE.map((succeeded) => (succeeded ? count + 1 : count)),
          ),
        ),
      ),
    TE.right(0),
  );

  return processAllEmails;
};

// Archive command definition
export const archiveCommand = command({
  name: "archive",
  description: "Archive emails from inbox to archive folder",
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
    ids: multioption({
      type: {
        ...string,
        from: EmailIds.from,
      },
      long: "id",
      short: "i",
      description: "Email ID to archive (can be specified multiple times)",
    }),
  },
  handler: async ({ username, password, ids }) => {
    console.log("Starting email archiving process...");
    console.log(`Connecting to Fastmail as ${username}`);
    console.log(`Email IDs to archive: ${ids.join(", ")}`);

    // Main program flow using fp-ts
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
          findInboxMailbox(mailboxes),
          TE.chain((inbox) =>
            pipe(
              findArchiveMailbox(mailboxes),
              TE.map((archive) => ({ client, accountId, inbox, archive })),
            ),
          ),
        ),
      ),
      TE.chain(({ client, accountId, inbox, archive }) =>
        pipe(
          verifyEmails(client, accountId, ids),
          TE.chain((verifiedIds) =>
            archiveEmails(client, accountId, verifiedIds, inbox.id, archive.id),
          ),
        ),
      ),
      TE.map((count) => {
        console.log(`Completed archiving ${count} emails`);
        return count;
      }),
    );

    return await pipe(
      program,
      TE.match(
        (error) => {
          console.error("ERROR DETAILS:");
          console.error(error);

          console.log("Email archive process failed");
          return 1;
        },
        (_) => {
          console.log("Email archive process complete!");
          return 0;
        },
      ),
    )();
  },
});
