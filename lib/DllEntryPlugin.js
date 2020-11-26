/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const DllModuleFactory = require("./DllModuleFactory");
const DllEntryDependency = require("./dependencies/DllEntryDependency");
const EntryDependency = require("./dependencies/EntryDependency");

class DllEntryPlugin {
	constructor(context, entries, options) {
		this.context = context;
		this.entries = entries;
		this.options = options;
	}

	apply(compiler) {
		compiler.hooks.compilation.tap(
			"DllEntryPlugin",
			(compilation, { normalModuleFactory }) => {
				const dllModuleFactory = new DllModuleFactory();
				compilation.dependencyFactories.set(
					DllEntryDependency,
					dllModuleFactory
				);
				compilation.dependencyFactories.set(
					EntryDependency,
					normalModuleFactory
				);
			}
		);
		// 这里compiler.hooks.make.tapAsync("DllEntryPlugin", callback)，在compile过程中会执行this.hooks.make.callAsync
		compiler.hooks.make.tapAsync("DllEntryPlugin", (compilation, callback) => {
			compilation.addEntry(
				this.context,
				// DllEntryDependency实例，带dependencies name type
				new DllEntryDependency(
					// dependencies
					this.entries.map((e, idx) => {
						const dep = new EntryDependency(e);
						dep.loc = {
							name: this.options.name,
							index: idx
						};
						return dep;
					}),
					this.options.name
				),
				this.options,
				callback
			);
		});
	}
}

module.exports = DllEntryPlugin;
