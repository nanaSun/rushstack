// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  FileSystem,
  ITerminal,
  Terminal,
  ConsoleTerminalProvider,
  Path,
  NewlineKind,
  LegacyAdapters,
  Async
} from '@rushstack/node-core-library';
import glob from 'glob';
import * as path from 'path';
import { EOL } from 'os';
import * as chokidar from 'chokidar';

/**
 * @public
 */
export interface ITypingsGeneratorBaseOptions {
  srcFolder: string;
  generatedTsFolder: string;
  secondaryGeneratedTsFolders?: string[];
  globsToIgnore?: string[];
  terminal?: ITerminal;
}

/**
 * @public
 */
export interface ITypingsGeneratorOptions<TTypingsResult = string | undefined>
  extends ITypingsGeneratorBaseOptions {
  fileExtensions: string[];
  parseAndGenerateTypings: (
    fileContents: string,
    filePath: string,
    relativePath: string
  ) => TTypingsResult | Promise<TTypingsResult>;
  getAdditionalOutputFiles?: (relativePath: string) => string[];
  /**
   * @deprecated
   *
   * TODO: Remove when version 1.0.0 is released.
   */
  filesToIgnore?: string[];
}

/**
 * This is a simple tool that generates .d.ts files for non-TS files.
 *
 * @public
 */
export class TypingsGenerator {
  // Map of resolved consumer file path -> Set<resolved dependency file path>
  private readonly _dependenciesOfFile: Map<string, Set<string>>;

  // Map of resolved dependency file path -> Set<resolved consumer file path>
  private readonly _consumersOfFile: Map<string, Set<string>>;

  // Map of resolved file path -> relative file path
  private readonly _relativePaths: Map<string, string>;

  protected _options: ITypingsGeneratorOptions;

  /**
   * The folder path that contains all input source files.
   */
  public readonly sourceFolderPath: string;

  /**
   * The glob pattern used to find input files to process.
   */
  public readonly inputFileGlob: string;

  /**
   * The glob patterns that should be ignored when finding input files to process.
   */
  public readonly ignoredFileGlobs: readonly string[];

  public constructor(options: ITypingsGeneratorOptions) {
    this._options = {
      ...options
    };

    if (options.filesToIgnore) {
      throw new Error('The filesToIgnore option is no longer supported. Please use globsToIgnore instead.');
    }

    if (!this._options.generatedTsFolder) {
      throw new Error('generatedTsFolder must be provided');
    }

    if (!this._options.srcFolder) {
      throw new Error('srcFolder must be provided');
    }
    this.sourceFolderPath = this._options.srcFolder;

    if (Path.isUnder(this._options.srcFolder, this._options.generatedTsFolder)) {
      throw new Error('srcFolder must not be under generatedTsFolder');
    }

    if (Path.isUnder(this._options.generatedTsFolder, this._options.srcFolder)) {
      throw new Error('generatedTsFolder must not be under srcFolder');
    }

    if (!this._options.fileExtensions || this._options.fileExtensions.length === 0) {
      throw new Error('At least one file extension must be provided.');
    }

    this.ignoredFileGlobs = this._options.globsToIgnore || [];

    if (!this._options.terminal) {
      this._options.terminal = new Terminal(new ConsoleTerminalProvider({ verboseEnabled: true }));
    }

    this._options.fileExtensions = this._normalizeFileExtensions(this._options.fileExtensions);

    this._dependenciesOfFile = new Map();
    this._consumersOfFile = new Map();
    this._relativePaths = new Map();

    this.inputFileGlob = `**/*+(${this._options.fileExtensions.join('|')})`;
  }

  /**
   * Generate typings for the provided input files.
   *
   * @param filePaths - The input files to process, relative to the source folder. If not provided,
   * all input files will be processed.
   */
  public async generateTypingsAsync(filePaths?: string[]): Promise<void> {
    if (!filePaths?.length) {
      filePaths = await LegacyAdapters.convertCallbackToPromise(glob, this.inputFileGlob, {
        cwd: this.sourceFolderPath,
        ignore: this.ignoredFileGlobs,
        nosort: true,
        nodir: true
      });
    }
    await this._reprocessFiles(filePaths);
  }

  public async runWatcherAsync(): Promise<void> {
    await FileSystem.ensureFolderAsync(this._options.generatedTsFolder);

    await new Promise((resolve, reject): void => {
      const watcher: chokidar.FSWatcher = chokidar.watch(this.inputFileGlob, {
        cwd: this.sourceFolderPath,
        ignored: this.ignoredFileGlobs
      });

      const queue: Set<string> = new Set();
      let timeout: NodeJS.Timeout | undefined;
      let processing: boolean = false;
      let flushAfterCompletion: boolean = false;

      const flushInternal: () => void = () => {
        processing = true;

        const toProcess: string[] = Array.from(queue);
        queue.clear();
        this._reprocessFiles(toProcess)
          .then(() => {
            processing = false;
            // If the timeout was invoked again, immediately reexecute with the changed files.
            if (flushAfterCompletion) {
              flushAfterCompletion = false;
              flushInternal();
            }
          })
          .catch(reject);
      };

      const debouncedFlush: () => void = () => {
        timeout = undefined;
        if (processing) {
          // If the callback was invoked while processing is ongoing, indicate that we should flush immediately
          // upon completion of the current change batch.
          flushAfterCompletion = true;
          return;
        }

        flushInternal();
      };

      const onChange: (relativePath: string) => void = (relativePath: string) => {
        queue.add(relativePath);
        if (timeout) {
          clearTimeout(timeout);
        }

        setTimeout(debouncedFlush, 100);
      };

      watcher.on('add', onChange);
      watcher.on('change', onChange);
      watcher.on('unlink', async (relativePath) => {
        await Promise.all(
          this.getOutputFilePaths(relativePath).map(async (outputFile: string) => {
            await FileSystem.deleteFileAsync(outputFile);
          })
        );
      });
      watcher.on('error', reject);
    });
  }

  /**
   * Register file dependencies that may effect the typings of a consumer file.
   * Note: This feature is only useful in watch mode.
   * The registerDependency method must be called in the body of parseAndGenerateTypings every
   * time because the registry for a file is cleared at the beginning of processing.
   */
  public registerDependency(consumer: string, rawDependency: string): void {
    // Need to normalize slashes in the dependency path
    const dependency: string = path.resolve(this._options.srcFolder, rawDependency);

    let dependencies: Set<string> | undefined = this._dependenciesOfFile.get(consumer);
    if (!dependencies) {
      dependencies = new Set();
      this._dependenciesOfFile.set(consumer, dependencies);
    }
    dependencies.add(dependency);

    let consumers: Set<string> | undefined = this._consumersOfFile.get(dependency);
    if (!consumers) {
      consumers = new Set();
      this._consumersOfFile.set(dependency, consumers);
    }
    consumers.add(consumer);
  }

  public getOutputFilePaths(relativePath: string): string[] {
    const typingsFilePaths: Iterable<string> = this._getTypingsFilePaths(relativePath);
    const additionalPaths: string[] | undefined = this._options.getAdditionalOutputFiles?.(relativePath);
    return additionalPaths ? [...typingsFilePaths, ...additionalPaths] : Array.from(typingsFilePaths);
  }

  private async _reprocessFiles(relativePaths: Iterable<string>): Promise<void> {
    // Build a queue of resolved paths
    const toProcess: Set<string> = new Set();
    for (const rawPath of relativePaths) {
      const relativePath: string = Path.convertToSlashes(rawPath);
      const resolvedPath: string = path.resolve(this._options.srcFolder, rawPath);
      this._relativePaths.set(resolvedPath, relativePath);
      toProcess.add(resolvedPath);
    }

    // Expand out all registered consumers, according to the current dependency graph
    for (const file of toProcess) {
      const consumers: Set<string> | undefined = this._consumersOfFile.get(file);
      if (consumers) {
        for (const consumer of consumers) {
          toProcess.add(consumer);
        }
      }
    }

    // Map back to the relative paths so that the information is available
    await Async.forEachAsync(
      toProcess,
      async (resolvedPath: string) => {
        const relativePath: string | undefined = this._relativePaths.get(resolvedPath);
        if (!relativePath) {
          throw new Error(`Missing relative path for file ${resolvedPath}`);
        }
        await this._parseFileAndGenerateTypingsAsync(relativePath, resolvedPath);
      },
      { concurrency: 20 }
    );
  }

  private async _parseFileAndGenerateTypingsAsync(relativePath: string, resolvedPath: string): Promise<void> {
    // Clear registered dependencies prior to reprocessing.
    this._clearDependencies(resolvedPath);

    try {
      const fileContents: string = await FileSystem.readFileAsync(resolvedPath);
      const typingsData: string | undefined = await this._options.parseAndGenerateTypings(
        fileContents,
        resolvedPath,
        relativePath
      );

      // Typings data will be undefined when no types should be generated for the parsed file.
      if (typingsData === undefined) {
        return;
      }

      const prefixedTypingsData: string = [
        '// This file was generated by a tool. Modifying it will produce unexpected behavior',
        '',
        typingsData
      ].join(EOL);

      const generatedTsFilePaths: Iterable<string> = this._getTypingsFilePaths(relativePath);
      for (const generatedTsFilePath of generatedTsFilePaths) {
        await FileSystem.writeFileAsync(generatedTsFilePath, prefixedTypingsData, {
          ensureFolderExists: true,
          convertLineEndings: NewlineKind.OsDefault
        });
      }
    } catch (e) {
      this._options.terminal!.writeError(
        `Error occurred parsing and generating typings for file "${resolvedPath}": ${e}`
      );
    }
  }

  /**
   * Removes the consumer from all extant dependencies
   */
  private _clearDependencies(consumer: string): void {
    const dependencies: Set<string> | undefined = this._dependenciesOfFile.get(consumer);
    if (dependencies) {
      for (const dependency of dependencies) {
        this._consumersOfFile.get(dependency)!.delete(consumer);
      }
      dependencies.clear();
    }
  }

  private *_getTypingsFilePaths(relativePath: string): Iterable<string> {
    const { generatedTsFolder, secondaryGeneratedTsFolders } = this._options;
    const dtsFilename: string = `${relativePath}.d.ts`;
    yield path.resolve(generatedTsFolder, dtsFilename);
    if (secondaryGeneratedTsFolders) {
      for (const secondaryGeneratedTsFolder of secondaryGeneratedTsFolders) {
        yield path.resolve(secondaryGeneratedTsFolder, dtsFilename);
      }
    }
  }

  private _normalizeFileExtensions(fileExtensions: string[]): string[] {
    const result: Set<string> = new Set();
    for (const fileExtension of fileExtensions) {
      if (!fileExtension.startsWith('.')) {
        result.add(`.${fileExtension}`);
      } else {
        result.add(fileExtension);
      }
    }

    return Array.from(result);
  }
}
