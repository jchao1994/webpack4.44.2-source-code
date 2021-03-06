/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const parseJson = require("json-parse-better-errors");
const asyncLib = require("neo-async");
const {
	SyncHook, // 同步方法
	SyncBailHook, // 熔断：当函数有任何返回值，就会在当前执行函数停止
	AsyncParallelHook, // 异步并行执行钩子
	AsyncSeriesHook // 异步串行钩子
} = require("tapable");
const { SizeOnlySource } = require("webpack-sources");
const Cache = require("./Cache");
const CacheFacade = require("./CacheFacade");
const Compilation = require("./Compilation");
const ConcurrentCompilationError = require("./ConcurrentCompilationError");
const ContextModuleFactory = require("./ContextModuleFactory");
const NormalModuleFactory = require("./NormalModuleFactory");
const RequestShortener = require("./RequestShortener");
const ResolverFactory = require("./ResolverFactory");
const Stats = require("./Stats");
const Watching = require("./Watching");
const WebpackError = require("./WebpackError");
const { Logger } = require("./logging/Logger");
const { join, dirname, mkdirp } = require("./util/fs");
const { makePathsRelative } = require("./util/identifier");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../declarations/WebpackOptions").EntryNormalized} Entry */
/** @typedef {import("../declarations/WebpackOptions").OutputNormalized} OutputOptions */
/** @typedef {import("../declarations/WebpackOptions").WatchOptions} WatchOptions */
/** @typedef {import("../declarations/WebpackOptions").WebpackOptionsNormalized} WebpackOptions */
/** @typedef {import("../declarations/WebpackOptions").WebpackPluginInstance} WebpackPluginInstance */
/** @typedef {import("./Chunk")} Chunk */
/** @typedef {import("./FileSystemInfo").FileSystemInfoEntry} FileSystemInfoEntry */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./util/fs").InputFileSystem} InputFileSystem */
/** @typedef {import("./util/fs").IntermediateFileSystem} IntermediateFileSystem */
/** @typedef {import("./util/fs").OutputFileSystem} OutputFileSystem */
/** @typedef {import("./util/fs").WatchFileSystem} WatchFileSystem */

/**
 * @typedef {Object} CompilationParams
 * @property {NormalModuleFactory} normalModuleFactory
 * @property {ContextModuleFactory} contextModuleFactory
 */

/**
 * @template T
 * @callback Callback
 * @param {Error=} err
 * @param {T=} result
 */

/**
 * @callback RunAsChildCallback
 * @param {Error=} err
 * @param {Chunk[]=} entries
 * @param {Compilation=} compilation
 */

/**
 * @typedef {Object} AssetEmittedInfo
 * @property {Buffer} content
 * @property {Source} source
 * @property {Compilation} compilation
 * @property {string} outputPath
 * @property {string} targetPath
 */

/**
 * @param {string[]} array an array
 * @returns {boolean} true, if the array is sorted
 */
const isSorted = array => {
	for (let i = 1; i < array.length; i++) {
		if (array[i - 1] > array[i]) return false;
	}
	return true;
};

/**
 * @param {Object} obj an object
 * @param {string[]} keys the keys of the object
 * @returns {Object} the object with properties sorted by property name
 */
const sortObject = (obj, keys) => {
	const o = {};
	for (const k of keys.sort()) {
		o[k] = obj[k];
	}
	return o;
};

class Compiler {
	/**
	 * @param {string} context the compilation path
	 */
	constructor(context) {
		// 定义生命周期钩子
		// Webpack 本质上是一种事件流的机制，它的工作流程就是将各个插件串联起来，而实现这一切的核心就是 Tapable
		// 这些 hooks 都是基于 Tapable
		this.hooks = Object.freeze({
			/** @type {SyncHook<[]>} */
			initialize: new SyncHook([]),

			/** @type {SyncBailHook<[Compilation], boolean>} */
			shouldEmit: new SyncBailHook(["compilation"]),
			/** @type {AsyncSeriesHook<[Stats]>} */
			done: new AsyncSeriesHook(["stats"]), // 一次编译完成后执行，回调参数：stats
			/** @type {SyncHook<[Stats]>} */
			afterDone: new SyncHook(["stats"]),
			/** @type {AsyncSeriesHook<[]>} */
			additionalPass: new AsyncSeriesHook([]),
			/** @type {AsyncSeriesHook<[Compiler]>} */
			beforeRun: new AsyncSeriesHook(["compiler"]),
			/** @type {AsyncSeriesHook<[Compiler]>} */
			run: new AsyncSeriesHook(["compiler"]), // 在编译器开始读取记录前执行
			/** @type {AsyncSeriesHook<[Compilation]>} */
			emit: new AsyncSeriesHook(["compilation"]), // 在生成文件到output目录之前执行，回调参数： compilation
			/** @type {AsyncSeriesHook<[string, AssetEmittedInfo]>} */
			assetEmitted: new AsyncSeriesHook(["file", "info"]),
			/** @type {AsyncSeriesHook<[Compilation]>} */
			afterEmit: new AsyncSeriesHook(["compilation"]), // 在生成文件到output目录之后执行

			/** @type {SyncHook<[Compilation, CompilationParams]>} */
			thisCompilation: new SyncHook(["compilation", "params"]),
			/** @type {SyncHook<[Compilation, CompilationParams]>} */
			compilation: new SyncHook(["compilation", "params"]), // 在一次compilation创建后执行插件
			/** @type {SyncHook<[NormalModuleFactory]>} */
			normalModuleFactory: new SyncHook(["normalModuleFactory"]),
			/** @type {SyncHook<[ContextModuleFactory]>}  */
			contextModuleFactory: new SyncHook(["contextModuleFactory"]),

			/** @type {AsyncSeriesHook<[CompilationParams]>} */
			beforeCompile: new AsyncSeriesHook(["params"]),
			/** @type {SyncHook<[CompilationParams]>} */
			compile: new SyncHook(["params"]), // 在一个新的compilation创建之前执行
			/** @type {AsyncParallelHook<[Compilation], Module>} */
			make: new AsyncParallelHook(["compilation"]), // 完成一次编译之前执行
			/** @type {AsyncParallelHook<[Compilation], Module>} */
			finishMake: new AsyncSeriesHook(["compilation"]),
			/** @type {AsyncSeriesHook<[Compilation]>} */
			afterCompile: new AsyncSeriesHook(["compilation"]),

			/** @type {AsyncSeriesHook<[Compiler]>} */
			watchRun: new AsyncSeriesHook(["compiler"]),
			/** @type {SyncHook<[Error]>} */
			failed: new SyncHook(["error"]),
			/** @type {SyncHook<[string | null, number]>} */
			invalid: new SyncHook(["filename", "changeTime"]),
			/** @type {SyncHook<[]>} */
			watchClose: new SyncHook([]),

			/** @type {SyncBailHook<[string, string, any[]], true>} */
			infrastructureLog: new SyncBailHook(["origin", "type", "args"]),

			// TODO the following hooks are weirdly located here
			// TODO move them for webpack 5
			/** @type {SyncHook<[]>} */
			environment: new SyncHook([]),
			/** @type {SyncHook<[]>} */
			afterEnvironment: new SyncHook([]),
			/** @type {SyncHook<[Compiler]>} */
			afterPlugins: new SyncHook(["compiler"]),
			/** @type {SyncHook<[Compiler]>} */
			afterResolvers: new SyncHook(["compiler"]),
			/** @type {SyncBailHook<[string, Entry], boolean>} */
			entryOption: new SyncBailHook(["context", "entry"])
		});

		/** @type {string=} */
		this.name = undefined;
		/** @type {Compilation=} */
		this.parentCompilation = undefined;
		/** @type {Compiler} */
		this.root = this;
		/** @type {string} */
		this.outputPath = "";

		/** @type {OutputFileSystem} */
		this.outputFileSystem = null;
		/** @type {IntermediateFileSystem} */
		this.intermediateFileSystem = null;
		/** @type {InputFileSystem} */
		this.inputFileSystem = null;
		/** @type {WatchFileSystem} */
		this.watchFileSystem = null;

		/** @type {string|null} */
		this.recordsInputPath = null;
		/** @type {string|null} */
		this.recordsOutputPath = null;
		this.records = {};
		/** @type {Set<string>} */
		this.managedPaths = new Set();
		/** @type {Set<string>} */
		this.immutablePaths = new Set();

		/** @type {Set<string>} */
		this.modifiedFiles = undefined;
		/** @type {Set<string>} */
		this.removedFiles = undefined;
		/** @type {Map<string, FileSystemInfoEntry | null>} */
		this.fileTimestamps = undefined;
		/** @type {Map<string, FileSystemInfoEntry | null>} */
		this.contextTimestamps = undefined;

		/** @type {ResolverFactory} */
		this.resolverFactory = new ResolverFactory();

		this.infrastructureLogger = undefined;

		/** @type {WebpackOptions} */
		this.options = /** @type {WebpackOptions} */ ({});

		this.context = context;

		this.requestShortener = new RequestShortener(context, this.root);

		this.cache = new Cache();

		this.compilerPath = "";

		/** @type {boolean} */
		this.running = false;

		/** @type {boolean} */
		this.idle = false;

		/** @type {boolean} */
		this.watchMode = false;

		/** @private @type {WeakMap<Source, { sizeOnlySource: SizeOnlySource, writtenTo: Map<string, number> }>} */
		this._assetEmittingSourceCache = new WeakMap();
		/** @private @type {Map<string, number>} */
		this._assetEmittingWrittenFiles = new Map();
	}

	/**
	 * @param {string} name cache name
	 * @returns {CacheFacade} the cache facade instance
	 */
	getCache(name) {
		return new CacheFacade(this.cache, `${this.compilerPath}${name}`);
	}

	/**
	 * @param {string | (function(): string)} name name of the logger, or function called once to get the logger name
	 * @returns {Logger} a logger with that name
	 */
	getInfrastructureLogger(name) {
		if (!name) {
			throw new TypeError(
				"Compiler.getInfrastructureLogger(name) called without a name"
			);
		}
		return new Logger(
			(type, args) => {
				if (typeof name === "function") {
					name = name();
					if (!name) {
						throw new TypeError(
							"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
						);
					}
				}
				if (this.hooks.infrastructureLog.call(name, type, args) === undefined) {
					if (this.infrastructureLogger !== undefined) {
						this.infrastructureLogger(name, type, args);
					}
				}
			},
			childName => {
				if (typeof name === "function") {
					if (typeof childName === "function") {
						return this.getInfrastructureLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
									);
								}
							}
							if (typeof childName === "function") {
								childName = childName();
								if (!childName) {
									throw new TypeError(
										"Logger.getChildLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					} else {
						return this.getInfrastructureLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					}
				} else {
					if (typeof childName === "function") {
						return this.getInfrastructureLogger(() => {
							if (typeof childName === "function") {
								childName = childName();
								if (!childName) {
									throw new TypeError(
										"Logger.getChildLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					} else {
						return this.getInfrastructureLogger(`${name}/${childName}`);
					}
				}
			}
		);
	}

	/**
	 * @param {WatchOptions} watchOptions the watcher's options
	 * @param {Callback<Stats>} handler signals when the call finishes
	 * @returns {Watching} a compiler watcher
	 */
	// 如果运行在watch模式则执行watch方法，否则执行run方法
	watch(watchOptions, handler) {
		if (this.running) {
			return handler(new ConcurrentCompilationError());
		}

		this.running = true;
		this.watchMode = true;
		return new Watching(this, watchOptions, handler);
	}

	/**
	 * @param {Callback<Stats>} callback signals when the call finishes
	 * @returns {void}
	 */
	// 如果运行在watch模式则执行watch方法，否则执行run方法编译
	// befornRun => run => beforeCompile => compile => thisCompilation => compilation => make => seal => afterCompile 构建整个应用
	// compiler负责监听文件和启动编译  compilation负责构建编译
	run(callback) {
		// 已经正在编译了，直接报错
		if (this.running) {
			return callback(new ConcurrentCompilationError());
		}

		let logger;

		// 最终完成后执行的回调
		const finalCallback = (err, stats) => {
			if (logger) logger.time("beginIdle");
			this.idle = true;
			this.cache.beginIdle();
			this.idle = true;
			if (logger) logger.timeEnd("beginIdle");
			// 标记编译结束，可以进行下一次编译
			this.running = false;
			// 在编译和输出的流程中遇到异常时，会触发 failed 事件
			if (err) {
				this.hooks.failed.call(err);
			}
			if (callback !== undefined) callback(err, stats);
			this.hooks.afterDone.call(stats);
		};

		// 记录编译开始时间
		const startTime = Date.now();

		// 标记正在编译
		this.running = true;

		// this.compile 的完成回调
		const onCompiled = (err, compilation) => {
			if (err) return finalCallback(err);

			if (this.hooks.shouldEmit.call(compilation) === false) {
				compilation.startTime = startTime;
				compilation.endTime = Date.now();
				const stats = new Stats(compilation);
				this.hooks.done.callAsync(stats, err => {
					if (err) return finalCallback(err);
					return finalCallback(null, stats);
				});
				return;
			}

			process.nextTick(() => {
				logger = compilation.getLogger("webpack.Compiler");
				logger.time("emitAssets");
				// emit 输出到dist目录
				// 创建dist目录，然后执行emitFiles，输出打包内容到dist目录
				this.emitAssets(compilation, err => {
					logger.timeEnd("emitAssets");
					if (err) return finalCallback(err);

					if (compilation.hooks.needAdditionalPass.call()) {
						compilation.needAdditionalPass = true;

						compilation.startTime = startTime;
						compilation.endTime = Date.now();
						logger.time("done hook");
						const stats = new Stats(compilation);
						// done 完成编译
						this.hooks.done.callAsync(stats, err => {
							logger.timeEnd("done hook");
							if (err) return finalCallback(err);

							this.hooks.additionalPass.callAsync(err => {
								if (err) return finalCallback(err);
								// 创建compilation对象之前
								this.compile(onCompiled);
							});
						});
						return;
					}

					logger.time("emitRecords");
					// emit 输出到records目录
					// 创建records目录，然后执行writeFile，输出打包内容到records目录
					this.emitRecords(err => {
						logger.timeEnd("emitRecords");
						if (err) return finalCallback(err);

						compilation.startTime = startTime;
						compilation.endTime = Date.now();
						logger.time("done hook");
						const stats = new Stats(compilation);
						this.hooks.done.callAsync(stats, err => {
							logger.timeEnd("done hook");
							if (err) return finalCallback(err);
							this.cache.storeBuildDependencies(
								compilation.buildDependencies,
								err => {
									if (err) return finalCallback(err);
									return finalCallback(null, stats);
								}
							);
						});
					});
				});
			});
		};

		const run = () => {
			// beforeRun 清除缓存
			this.hooks.beforeRun.callAsync(this, err => {
				if (err) return finalCallback(err);

				// run 注册缓存数据钩子
				this.hooks.run.callAsync(this, err => {
					if (err) return finalCallback(err);

					// 此时已经执行完 beforeRun.callAsync 和 run.callAsync
					// 也就是完成了插件的初始化
					// 这里主要是读取记录赋值到 this.records，然后执行 callback
					this.readRecords(err => {
						if (err) return finalCallback(err);

						// beforeCompile => compile => thisCompilation => compilation => make => seal => afterCompile
						this.compile(onCompiled);
					});
				});
			});
		};

		if (this.idle) {
			this.cache.endIdle(err => {
				if (err) return finalCallback(err);

				this.idle = false;
				run();
			});
		} else {
			run();
		}
	}

	/**
	 * @param {RunAsChildCallback} callback signals when the call finishes
	 * @returns {void}
	 */
	runAsChild(callback) {
		const startTime = Date.now();
		this.compile((err, compilation) => {
			if (err) return callback(err);

			this.parentCompilation.children.push(compilation);
			for (const { name, source, info } of compilation.getAssets()) {
				this.parentCompilation.emitAsset(name, source, info);
			}

			const entries = [];
			for (const ep of compilation.entrypoints.values()) {
				entries.push(...ep.chunks);
			}

			compilation.startTime = startTime;
			compilation.endTime = Date.now();

			return callback(null, entries, compilation);
		});
	}

	purgeInputFileSystem() {
		if (this.inputFileSystem && this.inputFileSystem.purge) {
			this.inputFileSystem.purge();
		}
	}

	/**
	 * @param {Compilation} compilation the compilation
	 * @param {Callback<void>} callback signals when the assets are emitted
	 * @returns {void}
	 */
	// emit 输出到dist目录
	// 创建dist目录，然后执行emitFiles，输出打包内容到dist目录
	emitAssets(compilation, callback) {
		let outputPath;

		// 输出打包内容到dist目录
		const emitFiles = err => {
			if (err) return callback(err);

			const assets = compilation.getAssets();
			compilation.assets = { ...compilation.assets };
			const caseInsensitiveMap = new Map();
			asyncLib.forEachLimit(
				assets,
				15,
				({ name: file, source, info }, callback) => {
					let targetFile = file;
					const queryStringIdx = targetFile.indexOf("?");
					if (queryStringIdx >= 0) {
						targetFile = targetFile.substr(0, queryStringIdx);
					}

					const writeOut = err => {
						if (err) return callback(err);
						const targetPath = join(
							this.outputFileSystem,
							outputPath,
							targetFile
						);

						const caseInsensitiveTargetPath = targetPath.toLowerCase();
						if (caseInsensitiveMap.has(caseInsensitiveTargetPath)) {
							const other = caseInsensitiveMap.get(caseInsensitiveTargetPath);
							const err =
								new WebpackError(`Prevent writing to file that only differs in casing or query string from already written file.
								This will lead to a race-condition and corrupted files on case-insensitive file systems.
								${targetPath}
								${other}`);
							err.file = file;
							return callback(err);
						} else {
							caseInsensitiveMap.set(caseInsensitiveTargetPath, targetPath);
						}

						// check if the target file has already been written by this Compiler
						const targetFileGeneration =
							this._assetEmittingWrittenFiles.get(targetPath);

						// create an cache entry for this Source if not already existing
						let cacheEntry = this._assetEmittingSourceCache.get(source);
						if (cacheEntry === undefined) {
							cacheEntry = {
								sizeOnlySource: undefined,
								writtenTo: new Map()
							};
							this._assetEmittingSourceCache.set(source, cacheEntry);
						}

						/**
						 * get the binary (Buffer) content from the Source
						 * @returns {Buffer} content for the source
						 */
						const getContent = () => {
							if (typeof source.buffer === "function") {
								return source.buffer();
							} else {
								const bufferOrString = source.source();
								if (Buffer.isBuffer(bufferOrString)) {
									return bufferOrString;
								} else {
									return Buffer.from(bufferOrString, "utf8");
								}
							}
						};

						const alreadyWritten = () => {
							// cache the information that the Source has been already been written to that location
							if (targetFileGeneration === undefined) {
								const newGeneration = 1;
								this._assetEmittingWrittenFiles.set(targetPath, newGeneration);
								cacheEntry.writtenTo.set(targetPath, newGeneration);
							} else {
								cacheEntry.writtenTo.set(targetPath, targetFileGeneration);
							}
							callback();
						};

						/**
						 * Write the file to output file system
						 * @param {Buffer} content content to be written
						 * @returns {void}
						 */
						const doWrite = content => {
							this.outputFileSystem.writeFile(targetPath, content, err => {
								if (err) return callback(err);

								// information marker that the asset has been emitted
								compilation.emittedAssets.add(file);

								// cache the information that the Source has been written to that location
								const newGeneration =
									targetFileGeneration === undefined
										? 1
										: targetFileGeneration + 1;
								cacheEntry.writtenTo.set(targetPath, newGeneration);
								this._assetEmittingWrittenFiles.set(targetPath, newGeneration);
								this.hooks.assetEmitted.callAsync(
									file,
									{
										content,
										source,
										outputPath,
										compilation,
										targetPath
									},
									callback
								);
							});
						};

						const updateWithReplacementSource = size => {
							// Create a replacement resource which only allows to ask for size
							// This allows to GC all memory allocated by the Source
							// (expect when the Source is stored in any other cache)
							if (!cacheEntry.sizeOnlySource) {
								cacheEntry.sizeOnlySource = new SizeOnlySource(size);
							}
							compilation.updateAsset(file, cacheEntry.sizeOnlySource, {
								size
							});
						};

						const processExistingFile = stats => {
							// skip emitting if it's already there and an immutable file
							if (info.immutable) {
								updateWithReplacementSource(stats.size);
								return alreadyWritten();
							}

							const content = getContent();

							updateWithReplacementSource(content.length);

							// if it exists and content on disk matches content
							// skip writing the same content again
							// (to keep mtime and don't trigger watchers)
							// for a fast negative match file size is compared first
							if (content.length === stats.size) {
								compilation.comparedForEmitAssets.add(file);
								return this.outputFileSystem.readFile(
									targetPath,
									(err, existingContent) => {
										if (err || !content.equals(existingContent)) {
											return doWrite(content);
										} else {
											return alreadyWritten();
										}
									}
								);
							}

							return doWrite(content);
						};

						const processMissingFile = () => {
							const content = getContent();

							updateWithReplacementSource(content.length);

							return doWrite(content);
						};

						// if the target file has already been written
						if (targetFileGeneration !== undefined) {
							// check if the Source has been written to this target file
							const writtenGeneration = cacheEntry.writtenTo.get(targetPath);
							if (writtenGeneration === targetFileGeneration) {
								// if yes, we skip writing the file
								// as it's already there
								// (we assume one doesn't remove files while the Compiler is running)

								compilation.updateAsset(file, cacheEntry.sizeOnlySource, {
									size: cacheEntry.sizeOnlySource.size()
								});

								return callback();
							}

							if (!info.immutable) {
								// We wrote to this file before which has very likely a different content
								// skip comparing and assume content is different for performance
								// This case happens often during watch mode.
								return processMissingFile();
							}
						}

						if (this.options.output.compareBeforeEmit) {
							this.outputFileSystem.stat(targetPath, (err, stats) => {
								const exists = !err && stats.isFile();

								if (exists) {
									processExistingFile(stats);
								} else {
									processMissingFile();
								}
							});
						} else {
							processMissingFile();
						}
					};

					if (targetFile.match(/\/|\\/)) {
						const fs = this.outputFileSystem;
						const dir = dirname(fs, join(fs, outputPath, targetFile));
						mkdirp(fs, dir, writeOut);
					} else {
						writeOut();
					}
				},
				err => {
					if (err) return callback(err);

					this.hooks.afterEmit.callAsync(compilation, err => {
						if (err) return callback(err);

						return callback();
					});
				}
			);
		};

		// emit 输出到dist目录
		this.hooks.emit.callAsync(compilation, err => {
			if (err) return callback(err);
			outputPath = compilation.getPath(this.outputPath, {});
			// 创建dist目录，然后执行emitFiles，输出打包内容到dist目录
			mkdirp(this.outputFileSystem, outputPath, emitFiles);
		});
	}

	/**
	 * @param {Callback<void>} callback signals when the call finishes
	 * @returns {void}
	 */
	// emit 输出到records目录
	// 创建records目录，然后执行writeFile，输出打包内容到records目录
	emitRecords(callback) {
		if (!this.recordsOutputPath) return callback();

		// 输出records内容到records目录
		const writeFile = () => {
			this.outputFileSystem.writeFile(
				this.recordsOutputPath,
				JSON.stringify(
					this.records,
					(n, value) => {
						if (
							typeof value === "object" &&
							value !== null &&
							!Array.isArray(value)
						) {
							const keys = Object.keys(value);
							if (!isSorted(keys)) {
								return sortObject(value, keys);
							}
						}
						return value;
					},
					2
				),
				callback
			);
		};

		// records目录
		const recordsOutputPathDirectory = dirname(
			this.outputFileSystem,
			this.recordsOutputPath
		);
		if (!recordsOutputPathDirectory) {
			return writeFile();
		}
		// 创建records目录，然后执行回调，执行writeFile
		mkdirp(this.outputFileSystem, recordsOutputPathDirectory, err => {
			if (err) return callback(err);
			writeFile();
		});
	}

	/**
	 * @param {Callback<void>} callback signals when the call finishes
	 * @returns {void}
	 */
	// 此时已经执行完 beforeRun.callAsync 和 run.callAsync
	// 也就是完成了插件的初始化
	// 这里主要是读取记录赋值到 this.records，然后执行 callback
	readRecords(callback) {
		// 没有记录，直接执行 callback
		if (!this.recordsInputPath) {
			this.records = {};
			return callback();
		}
		// 有记录，读取并赋值 this.records，然后执行 callback
		this.inputFileSystem.stat(this.recordsInputPath, err => {
			// It doesn't exist
			// We can ignore this.
			if (err) return callback();

			this.inputFileSystem.readFile(this.recordsInputPath, (err, content) => {
				if (err) return callback(err);

				try {
					this.records = parseJson(content.toString("utf-8"));
				} catch (e) {
					e.message = "Cannot parse records: " + e.message;
					return callback(e);
				}

				return callback();
			});
		});
	}

	/**
	 * @param {Compilation} compilation the compilation
	 * @param {string} compilerName the compiler's name
	 * @param {number} compilerIndex the compiler's index
	 * @param {OutputOptions} outputOptions the output options
	 * @param {WebpackPluginInstance[]} plugins the plugins to apply
	 * @returns {Compiler} a child compiler
	 */
	createChildCompiler(
		compilation,
		compilerName,
		compilerIndex,
		outputOptions,
		plugins
	) {
		const childCompiler = new Compiler(this.context);
		childCompiler.name = compilerName;
		childCompiler.outputPath = this.outputPath;
		childCompiler.inputFileSystem = this.inputFileSystem;
		childCompiler.outputFileSystem = null;
		childCompiler.resolverFactory = this.resolverFactory;
		childCompiler.modifiedFiles = this.modifiedFiles;
		childCompiler.removedFiles = this.removedFiles;
		childCompiler.fileTimestamps = this.fileTimestamps;
		childCompiler.contextTimestamps = this.contextTimestamps;
		childCompiler.cache = this.cache;
		childCompiler.compilerPath = `${this.compilerPath}${compilerName}|${compilerIndex}|`;

		const relativeCompilerName = makePathsRelative(
			this.context,
			compilerName,
			this.root
		);
		if (!this.records[relativeCompilerName]) {
			this.records[relativeCompilerName] = [];
		}
		if (this.records[relativeCompilerName][compilerIndex]) {
			childCompiler.records = this.records[relativeCompilerName][compilerIndex];
		} else {
			this.records[relativeCompilerName].push((childCompiler.records = {}));
		}

		childCompiler.options = {
			...this.options,
			output: {
				...this.options.output,
				...outputOptions
			}
		};
		childCompiler.parentCompilation = compilation;
		childCompiler.root = this.root;
		if (Array.isArray(plugins)) {
			for (const plugin of plugins) {
				plugin.apply(childCompiler);
			}
		}
		for (const name in this.hooks) {
			if (
				![
					"make",
					"compile",
					"emit",
					"afterEmit",
					"invalid",
					"done",
					"thisCompilation"
				].includes(name)
			) {
				if (childCompiler.hooks[name]) {
					childCompiler.hooks[name].taps = this.hooks[name].taps.slice();
				}
			}
		}

		compilation.hooks.childCompiler.call(
			childCompiler,
			compilerName,
			compilerIndex
		);

		return childCompiler;
	}

	isChild() {
		return !!this.parentCompilation;
	}

	createCompilation() {
		return new Compilation(this);
	}

	/**
	 * @param {CompilationParams} params the compilation parameters
	 * @returns {Compilation} the created compilation
	 */
	// 创建Compilation实例，执行 thisCompilation 和 compilation 钩子
	newCompilation(params) {
		// 创建Compilation对象回调compilation相关钩子
		const compilation = this.createCompilation();
		compilation.name = this.name;
		compilation.records = this.records;
		this.hooks.thisCompilation.call(compilation, params);
		// compilation对象创建完成
		this.hooks.compilation.call(compilation, params);
		return compilation;
	}

	createNormalModuleFactory() {
		const normalModuleFactory = new NormalModuleFactory({
			context: this.options.context,
			fs: this.inputFileSystem,
			resolverFactory: this.resolverFactory,
			options: this.options.module || {},
			associatedObjectForCache: this.root
		});
		this.hooks.normalModuleFactory.call(normalModuleFactory);
		return normalModuleFactory;
	}

	createContextModuleFactory() {
		const contextModuleFactory = new ContextModuleFactory(this.resolverFactory);
		this.hooks.contextModuleFactory.call(contextModuleFactory);
		return contextModuleFactory;
	}

	newCompilationParams() {
		const params = {
			normalModuleFactory: this.createNormalModuleFactory(),
			contextModuleFactory: this.createContextModuleFactory()
		};
		return params;
	}

	/**
	 * @param {Callback<Compilation>} callback signals when the compilation finishes
	 * @returns {void}
	 */
	// beforeCompile => compile => thisCompilation => compilation => make => seal => afterCompile
	// 创建compilation实例
	// 此时已经执行完 beforeRun.callAsync 和 run.callAsync，并且读取了记录，存放在 this.records 上
	compile(callback) {
		// { normalModuleFactory, contextModuleFactory }
		const params = this.newCompilationParams();
		// beforeCompile
		this.hooks.beforeCompile.callAsync(params, err => {
			if (err) return callback(err);

			// compile 开始编译，同步流程
			this.hooks.compile.call(params);

			// 创建compilation实例，执行 thisCompilation 和 compilation 钩子
			// Compilation负责整个编译过程，包含了每个构建环节所对应的方法。对象内部保留了对compiler的引用
			// 当 Webpack 以开发模式运行时，每当检测到文件变化，一次新的 Compilation 将被创建
			// Compilation很重要！编译生产资源变换文件都靠它
			const compilation = this.newCompilation(params);

			const logger = compilation.getLogger("webpack.Compiler");

			logger.time("make hook");
			// make 从入口分析依赖以及间接依赖模块，创建模块对象
			// 触发make事件并调用addEntry，找到入口js，进行下一步
			// this.hooks.make.tapAsync在 lib/DllEntryPlugin.js 中绑定，内部就是执行compilation.addEntry
			this.hooks.make.callAsync(compilation, err => {
				logger.timeEnd("make hook");
				if (err) return callback(err);

				logger.time("finish make hook");
				this.hooks.finishMake.callAsync(compilation, err => {
					logger.timeEnd("finish make hook");
					if (err) return callback(err);

					process.nextTick(() => {
						logger.time("finish compilation");
						// finish compilation => 执行 this.hooks.finishModules.callAsync
						// 主要作用是提取modules的警告和错误
						// 结束之后，执行传入的回调
						compilation.finish(err => {
							logger.timeEnd("finish compilation");
							if (err) return callback(err);

							logger.time("seal compilation");
							// seal 构建结果封装，不可再更改
							// 封装构建结果(seal)，逐次对每个module和chunk进行整理，每个chunk对应一个入口文件
							compilation.seal(err => {
								logger.timeEnd("seal compilation");
								if (err) return callback(err);

								logger.time("afterCompile hook");
								// afterCompile 完成构建，缓存数据
								// 异步的事件需要在插件处理完任务时调用回调函数通知 Webpack 进入下一个流程，
								// 不然运行流程将会一直卡在这不往下执行
								// 完成这一步之后就执行回调 callback，也就是 onCompiled
								this.hooks.afterCompile.callAsync(compilation, err => {
									logger.timeEnd("afterCompile hook");
									if (err) return callback(err);

									return callback(null, compilation);
								});
							});
						});
					});
				});
			});
		});
	}

	/**
	 * @param {Callback<void>} callback signals when the compiler closes
	 * @returns {void}
	 */
	close(callback) {
		this.cache.shutdown(callback);
	}
}

module.exports = Compiler;
