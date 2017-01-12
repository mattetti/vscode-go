/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import cp = require('child_process');
import path = require('path');
import os = require('os');
import fs = require('fs');
import { getBinPath, getGoRuntimePath } from './goPath';
import { getCoverage } from './goCover';
import { outputChannel } from './goStatus';
import { promptForMissingTool } from './goInstallTools';
import { parseFilePrelude } from './util';

export interface ICheckResult {
	file: string;
	line: number;
	msg: string;
	severity: string;
}

function runTool(cmd: string, args: string[], cwd: string, severity: string, useStdErr: boolean, toolName: string, notFoundError?: string) {
	return new Promise((resolve, reject) => {
		cp.execFile(cmd, args, { cwd: cwd }, (err, stdout, stderr) => {
			try {
				if (err && (<any>err).code === 'ENOENT') {
					if (toolName) {
						promptForMissingTool(toolName);
					} else {
						vscode.window.showInformationMessage(notFoundError);
					}
					return resolve([]);
				}
				let lines = (useStdErr ? stderr : stdout).toString().split('\n');
				outputChannel.appendLine(['Finished running tool:', cmd, ...args].join(' '));

				let ret: ICheckResult[] = [];
				for (let i = 0; i < lines.length; i++) {
					if (lines[i][0] === '\t' && ret.length > 0) {
						ret[ret.length - 1].msg += '\n' + lines[i];
						continue;
					}
					let match = /^([^:]*: )?((.:)?[^:]*):(\d+)(:(\d+)?)?:(?:\w+:)? (.*)$/.exec(lines[i]);
					if (!match) continue;
					let [_, __, file, ___, lineStr, ____, charStr, msg] = match;
					let line = +lineStr;
					file = path.resolve(cwd, file);
					ret.push({ file, line, msg, severity });
					outputChannel.appendLine(`${file}:${line}: ${msg}`);
				}
				outputChannel.appendLine('');
				resolve(ret);
			} catch (e) {
				reject(e);
			}
		});
	});
}

export function check(filename: string, goConfig: vscode.WorkspaceConfiguration): Promise<ICheckResult[]> {
	outputChannel.clear();
	let runningToolsPromises = [];
	let cwd = path.dirname(filename);
	let goRuntimePath = getGoRuntimePath();

	if (!goRuntimePath) {
		vscode.window.showInformationMessage('Cannot find "go" binary. Update PATH or GOROOT appropriately');
		return Promise.resolve([]);
	}

	if (!!goConfig['buildOnSave']) {
		// we need to parse the file to check the package name
		// if the package is a main pkg, we won't be doing a go build -i
		let buildPromise = new Promise<ICheckResult[]>((resolve, reject) => {
			let isMainPkg = false;
			fs.readFile(filename, 'utf8', (err, data) => {
				if (err) {
					return;
				}
				let prelude = parseFilePrelude(data);
				if (prelude.pkg) {
					isMainPkg = prelude.pkg.name === 'main';
				}

				let buildFlags = goConfig['buildFlags'] || [];
				let buildTags = '"' + goConfig['buildTags'] + '"';
				let tmppath = path.normalize(path.join(os.tmpdir(), 'go-code-check'));
				let args = ['build'];
				if (!isMainPkg) {
					args.push('- i');
				};
				args = args.concat(['-o', tmppath, '-tags', buildTags, ...buildFlags, '.']);
				if (filename.match(/_test.go$/i)) {
					args = ['test', '-copybinary', '-o', tmppath, '-c', '-tags', buildTags, ...buildFlags, '.'];
				}
				runTool(
					goRuntimePath,
					args,
					cwd,
					'error',
					true,
					null,
					`Cannot find ${goRuntimePath}`
				).then(result => return resolve(result), err => return reject(err));
			});
		});
		runningToolsPromises.push(buildPromise);
	}
	if (!!goConfig['lintOnSave']) {
		let lintTool = getBinPath(goConfig['lintTool'] || 'golint');
		let lintFlags = goConfig['lintFlags'] || [];
		let args = [...lintFlags];

		if (lintTool === 'golint') {
			args.push(filename);
		}

		runningToolsPromises.push(runTool(
			lintTool,
			args,
			cwd,
			'warning',
			lintTool === 'golint',
			lintTool === 'golint' ? 'golint' : null,
			lintTool === 'golint' ? undefined : 'No "gometalinter" could be found.  Install gometalinter to use this option.'
		));
	}

	if (!!goConfig['vetOnSave']) {
		let vetFlags = goConfig['vetFlags'] || [];
		runningToolsPromises.push(runTool(
			goRuntimePath,
			['tool', 'vet', ...vetFlags, filename],
			cwd,
			'warning',
			true,
			null,
			`Cannot find ${goRuntimePath}`
		));
	}

	if (!!goConfig['coverOnSave']) {
		runningToolsPromises.push(getCoverage(filename));
	}

	return Promise.all(runningToolsPromises).then(resultSets => [].concat.apply([], resultSets));
}
