import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extendType, string } from "cmd-ts";
import * as E from "fp-ts/lib/Either.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";

/**
 * Base class for filesystem-related errors
 */
export class FilesystemError extends Error {
  cause?: Error;
  
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
    Object.setPrototypeOf(this, FilesystemError.prototype);
  }
}

/**
 * Error thrown when a path is not found
 */
export class PathNotFoundError extends FilesystemError {
  path: string;

  constructor(path: string) {
    super(`Path doesn't exist: ${path}`);
    this.path = path;
    Object.setPrototypeOf(this, PathNotFoundError.prototype);
  }
}

/**
 * Error thrown when a path is expected to be a directory but is not
 */
export class NotADirectoryError extends FilesystemError {
  path: string;

  constructor(path: string) {
    super(`Path exists but is not a directory: ${path}`);
    this.path = path;
    Object.setPrototypeOf(this, NotADirectoryError.prototype);
  }
}

/**
 * Error thrown when a directory creation fails
 */
export class DirectoryCreationFailedError extends FilesystemError {
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

/**
 * Error thrown when a file operation fails
 */
export class FileError extends FilesystemError {
  cause?: Error;
  path: string;

  constructor(path: string, message: string, cause?: Error) {
    super(`File error with ${path}: ${message}`);
    this.path = path;
    this.cause = cause;
    Object.setPrototypeOf(this, FileError.prototype);
  }
}

/**
 * Check if a path is a directory
 */
export const isDirectory = (path: string): TE.TaskEither<FilesystemError, string> =>
  pipe(
    TE.tryCatch(
      () => fs.stat(path),
      (err) =>
        new FilesystemError(
          String(err),
          err instanceof Error ? err : undefined,
        ) as FilesystemError,
    ),
    TE.chain((stats) => {
      if (stats.isDirectory()) {
        return TE.right(path);
      }
      return TE.left<FilesystemError, string>(new NotADirectoryError(path));
    }),
  );

/**
 * Create a directory if it doesn't exist
 */
export const createDirectoryIfNotExists = (
  dirPath: string,
): TE.TaskEither<FilesystemError, string> =>
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

/**
 * Read and parse a JSON file
 */
export const readJsonFile = <T>(
  filePath: string,
): TE.TaskEither<FilesystemError, T> =>
  pipe(
    TE.tryCatch(
      () => fs.readFile(filePath, 'utf8'),
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
export const writeJsonFile = <T>(
  filePath: string,
  data: T,
): TE.TaskEither<FilesystemError, void> =>
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
 * Extended cmd-ts type for output directory
 */
export const OutputDirectory = extendType(string, {
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