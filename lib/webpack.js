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
// 注册所有配置的插件和内置插件以及初始化默认配置
const createCompiler = rawOptions => {
	// 统一处理传入的配置rawOptions
	const options = getNormalizedWebpackOptions(rawOptions);
	// 应用默认的Webpack基础配置
	applyWebpackOptionsBaseDefaults(options);
	// 实例化compiler
	const compiler = new Compiler(options.context);
	compiler.options = options;
	// 注册NodeEnvironmentPlugin插件
	// 应用Node的文件系统到compiler对象，方便后续的文件查找和读取
	new NodeEnvironmentPlugin({
		infrastructureLogging: options.infrastructureLogging
	}).apply(compiler);
	// 注册所有配置的插件plugins，为 webpack 事件流挂上自定义钩子
	// 依次调用插件的apply方法（默认每个插件对象实例都需要提供一个apply）若为函数则直接调用
	// 插件的apply方法会给compiler实例的各个hook绑定对应的方法
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
	// 这里会调用compiler.hooks.entryOption.call，而compiler.hooks.entryOption.tap在上面注册DllPlugin插件的时候就已经绑定了
	// 这里compiler.hooks.make.tapAsync("DllEntryPlugin", callback)，在compile过程中会执行this.hooks.make.callAsync
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
// 1. 定义一个模块加载函数 webpack_require
// 2. 使用加载函数加载入口模块 "./src/index.js"，从入口文件开始递归解析依赖，在解析的过程中，分别对不同的模块进行处理，返回模块的 exports

// Compiler 负责监听文件和启动编译
// 		它可以读取到 webpack 的 config 信息，整个 Webpack 从启动到关闭的生命周期，一般只有一个 Compiler 实例
// 		整个生命周期里暴露了很多方法，常见的 run,make,compile,finish,seal,emit 等，我们写的插件就是作用在这些暴露方法的 hook 上
// Compilation 负责构建编译
// 		每一次编译（文件只要发生变化）就会生成一个 Compilation 实例
// 		Compilation 可以读取到当前的模块资源，编译生成资源，变化的文件，以及依赖跟踪等状态信息。同时也提供很多事件回调给插件进行拓展
const webpack = /** @type {WebpackFunctionSingle & WebpackFunctionMulti} */ (
	(options, callback) => {
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
			// 注册所有配置的插件和内置插件以及初始化默认配置
			compiler = createCompiler(options);
			watch = options.watch;
			watchOptions = options.watchOptions || {};
		}
		if (callback) {
			if (watch) {
				// 监听模式
				// 传入options.watch，则开启watch线程(--watch)
				// 传递监听的 watchOptions，生成 Watching 实例，每次变化都重新触发回调
				compiler.watch(watchOptions, callback);
			} else {
				// 非监听模式
				// 调用run方法开始编译
				// befornRun => run => beforeCompile => compile => thisCompilation => compilation => make => seal => afterCompile
				compiler.run((err, stats) => {
					compiler.close(err2 => {
						callback(err || err2, stats);
					});
				});
			}
		}
		return compiler;
	}
);

module.exports = webpack;
