import { command, option, string, flag, extendType } from "cmd-ts";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import { JamClient } from "jmap-jam";

const ExistingPath = extendType(string, {
  displayName: "path",
  description: "An existing path",
  async from(str) {
    const resolved = path.resolve(str);
    if (!existsSync(resolved)) {
      throw new Error("Path doesn't exist");
    }
    return resolved;
  },
});

const EmailLimitType = extendType(string, {
  displayName: "email-limit",
  description: 'Number of emails to fetch or "all"',
  async from(limitStr) {
    if (limitStr.toLowerCase() === "all") {
      return Infinity;
    }

    const num = parseInt(limitStr, 10);
    if (isNaN(num) || num <= 0) {
      throw new Error('Limit must be a positive number or "all"');
    }

    return num;
  },
});

/**
 * Command to fetch emails from Fastmail using JMAP API
 */
export const getEmailsCommand = command({
  name: "get-emails",
  description: "Fetch emails from Fastmail using JMAP API",
  args: {
    username: option({
      type: string,
      long: "username",
      short: "u",
      description: "Fastmail username (fallback to FASTMAIL_USERNAME env var)",
      env: "FASTMAIL_USERNAME",
    }),
    password: option({
      type: string,
      long: "password",
      short: "p",
      description:
        "Fastmail API token/password (fallback to FASTMAIL_PASSWORD env var)",
      env: "FASTMAIL_PASSWORD",
    }),
    outputDir: option({
      type: ExistingPath,
      long: "output",
      short: "o",
      description: "Directory to save email data",
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
    console.log(`Output directory set to: ${outputDir}`);

    console.log(`Starting email fetch process...`);
    console.log(`Connecting to Fastmail as ${username}`);
    console.log(`Output directory: ${outputDir}`);
    console.log(`Email limit: ${limit}`);

    try {
      console.log("Initializing JMAP client...");
      const client = new JamClient({
        sessionUrl: "https://api.fastmail.com/jmap/session",
        bearerToken: password,
      });

      // Get account ID
      console.log("Getting account ID...");
      const accountId = await client.getPrimaryAccount();
      console.log(`Connected to account: ${accountId}`);

      // Get mailboxes (folders)
      console.log("Fetching mailboxes...");
      const [mailboxesResponse] = await client.request([
        "Mailbox/get",
        {
          accountId,
          properties: ["id", "name", "role", "totalEmails"],
        },
      ]);

      const mailboxes = mailboxesResponse.list || [];

      // Find the inbox
      const inbox = mailboxes.find((box: any) => box.role === "inbox");
      if (!inbox) {
        console.error("Could not find inbox folder");
        process.exit(1);
      }

      console.log(
        `Found inbox: ${inbox.name} with ${inbox.totalEmails} emails`,
      );

      // Get emails from inbox
      console.log("Fetching emails...");
      const [emailsResponse] = await client.request([
        "Email/query",
        {
          accountId,
          filter: {
            inMailbox: inbox.id,
          },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit,
          calculateTotal: true,
        },
      ]);

      if (!emailsResponse.ids || emailsResponse.ids.length === 0) {
        console.log("No emails found in inbox");
        process.exit(0);
      }

      console.log(`Found ${emailsResponse.ids.length} emails`);

      // Get email details
      const [emailsData] = await client.request([
        "Email/get",
        {
          accountId,
          ids: emailsResponse.ids,
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

      const emails = emailsData.list || [];

      // Process each email
      let emailCount = 0;
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

        // Save email data to file
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

        // Save to file
        await fs.writeFile(
          filePath,
          JSON.stringify(emailData, null, pretty ? 2 : 0),
          "utf8",
        );

        console.log(
          `Saved email ${emailCount}: ${email.subject || "No Subject"}`,
        );
      }

      console.log(`Completed processing ${emailCount} emails`);
    } catch (error) {
      console.error(error);
      console.error(`Error during email processing: ${error}`);
      process.exit(1);
    }

    console.log("Email fetch process complete!");
  },
});
