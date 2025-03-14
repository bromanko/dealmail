import { command, extendType, multioption, option, string } from "cmd-ts";
import * as E from "fp-ts/lib/Either.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";
import {
  JmapError,
  initializeJamClient,
  getAccountId,
  getMailboxes,
  findMailboxByRole,
  verifyEmails,
  archiveEmail,
  validateRequired,
  ApiError,
} from "../jmap.js";
import type JamClient from "jmap-jam";

class ArchiveError extends JmapError {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, ArchiveError.prototype);
  }
}

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
          findMailboxByRole(mailboxes, "inbox"),
          TE.chain((inbox) =>
            pipe(
              findMailboxByRole(mailboxes, "archive"),
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
