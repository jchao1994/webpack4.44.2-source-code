/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const webpackOptionsSchema = require("../schemas/WebpackOptions.json");
const Compiler = require("./Compiler");
const MultiCompiler = require("./MultiCompiler");
const WebpackOptionsApply = require("./WebpackOptionsApply");
const {
	applyWebpackOptionsDefaults,
	applyWebpackOptionsBaseDefaults
} = require("./config/defaults");
const { getNormalizedWebpackOptions } = require("./config/normalization");
const NodeEnvironmentPlugin = require("./node/NodeEnvironmentPlugin");
const validateSchema = require("./validateSchema");

/** @typedef {import("../declarations/WebpackOptions").WebpackOptions} WebpackOptions */
/** @typedef {import("./Compiler")} Compiler */
/** @typedef {import("./Compiler").WatchOptions} WatchOptions */
/** @typedef {import("./MultiCompiler")} MultiCompiler */
/** @typedef {import("./MultiStats")} MultiStats */
/** @typedef {import("./Stats")} Stats */

/**
 * @template T
 * @callback Callback
 * @param {Error=} err
 * @param {T=} stats
 * @returns {void}
 */

/**
 * @param {WebpackOptions[]} childOptions options array
 * @returns {MultiCompiler} a multi-compiler
 */
const createMultiCompiler = childOptions => {
	const compilers = childOptions.map(options => createCompiler(options));
	const compiler = new MultiCompiler(compilers);
	for (const childCompiler of compilers) {
		if (childCompiler.options.dependencies) {
			compiler.setDependencies(
				childCompiler,
				childCompiler.options.dependencies
			);
		}
	}
	return compiler;
};

/**
 * @param {WebpackOptions} rawOptions options object
 * @returns {Compiler} a compiler
 */
// 实例化compiler
// 注册内置插件以及初始化
const createCompiler = rawOptions => {
	const options = getNormalizedWebpackOptions(rawOptions);
	applyWebpackOptionsBaseDefaults(options);
	// 实例化compiler
	const compiler = new Compiler(options.context);
	compiler.options = options;
	// 注册NodeEnvironmentPlugin插件
	// 应用Node的文件系统到compiler对象，方便后续的文件查找和读取
	new NodeEnvironmentPlugin({
		infrastructureLogging: options.infrastructureLogging
	}).apply(compiler);
	// 注册所有内置插件，为 webpack 事件流挂上自定义钩子
	// 依次调用插件的apply方法（默认每个插件对象实例都需要提供一个apply）若为函数则直接调用
	if (Array.isArray(options.plugins)) {
		for (const plugin of options.plugins) {
			if (typeof plugin === "function") {
				plugin.call(compiler, compiler);
			} else {
				plugin.apply(compiler);
			}
		}
	}
	// 应用默认的Webpack配置
	applyWebpackOptionsDefaults(options);
	// 触发一些Hook
	compiler.hooks.environment.call();
	compiler.hooks.afterEnvironment.call();
	// 内置插件WebpackOptionsApply的引入，对webpack options进行初始化
	new WebpackOptionsApply().process(options, compiler);
	compiler.hooks.initialize.call();
	// 返回compiler实例
	return compiler;
};

/**
 * @callback WebpackFunctionSingle
 * @param {WebpackOptions} options options object
 * @param {Callback<Stats>=} callback callback
 * @returns {Compiler} the compiler object
 */

/**
 * @callback WebpackFunctionMulti
 * @param {WebpackOptions[]} options options objects
 * @param {Callback<MultiStats>=} callback callback
 * @returns {MultiCompiler} the multi compiler object
 */

 // webpack入口
const webpack = /** @type {WebpackFunctionSingle & WebpackFunctionMulti} */ ((
	options,
	callback
) => {
	validateSchema(webpackOptionsSchema, options);
	/** @type {MultiCompiler|Compiler} */
	let compiler;
	let watch = false;
	/** @type {WatchOptions|WatchOptions[]} */
	let watchOptions;
	// 实例化compiler
	if (Array.isArray(options)) {
		/** @type {MultiCompiler} */
		// 多个compiler
		compiler = createMultiCompiler(options);
		watch = options.some(options => options.watch);
		watchOptions = options.map(options => options.watchOptions || {});
	} else {
		/** @type {Compiler} */
		// 单个compiler
		// 实例化compiler
		// 注册内置插件以及初始化
		compiler = createCompiler(options);
		watch = options.watch;
		watchOptions = options.watchOptions || {};
	}
	if (callback) {
		if (watch) {
			// 传入options.watch，则开启watch线程
			compiler.watch(watchOptions, callback);
		} else {
			// 调用run方法开始编译
			compiler.run((err, stats) => {
				compiler.close(err2 => {
					callback(err || err2, stats);
				});
			});
		}
	}
	return compiler;
});

module.exports = webpack;
