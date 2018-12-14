// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { JSONObject } from '@phosphor/coreutils/lib/json';
import { assert } from 'chai';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Observable } from 'rxjs/Observable';
import { anyString, anything, instance, match, mock, when } from 'ts-mockito';
import { Matcher } from 'ts-mockito/lib/matcher/type/Matcher';
import * as TypeMoq from 'typemoq';
import * as uuid from 'uuid/v4';
import { Disposable, Event, EventEmitter, CancellationTokenSource } from 'vscode';

import { PythonSettings } from '../../client/common/configSettings';
import { ConfigurationService } from '../../client/common/configuration/service';
import { Logger } from '../../client/common/logger';
import { FileSystem } from '../../client/common/platform/fileSystem';
import { IFileSystem, TemporaryFile } from '../../client/common/platform/types';
import { ProcessServiceFactory } from '../../client/common/process/processFactory';
import { PythonExecutionFactory } from '../../client/common/process/pythonExecutionFactory';
import {
    ExecutionResult,
    IProcessService,
    IPythonExecutionService,
    ObservableExecutionResult,
    Output,
    IProcessServiceFactory,
    IPythonExecutionFactory
} from '../../client/common/process/types';
import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry, ILogger } from '../../client/common/types';
import { Architecture } from '../../client/common/utils/platform';
import { EXTENSION_ROOT_DIR } from '../../client/constants';
import { JupyterExecution } from '../../client/datascience/jupyter/jupyterExecution';
import { ICell, IConnection, IJupyterKernelSpec, INotebookServer, InterruptResult, IJupyterSessionManager, IJupyterSession, CellState } from '../../client/datascience/types';
import { InterpreterType, PythonInterpreter, IInterpreterService } from '../../client/interpreter/contracts';
import { InterpreterService } from '../../client/interpreter/interpreterService';
import { CondaService } from '../../client/interpreter/locators/services/condaService';
import { KnownSearchPathsForInterpreters } from '../../client/interpreter/locators/services/KnownPathsService';
import { ServiceContainer } from '../../client/ioc/container';
import { getOSType, OSType } from '../common';
import { noop, sleep } from '../core';
import { IServiceManager } from '../../client/ioc/types';
import { CancellationToken } from 'vscode-jsonrpc';
import { Cancellation } from '../../client/common/cancellation';
import { nbformat } from '@jupyterlab/coreutils';
import { generateCells } from '../../client/datascience/cellFactory';
import { KernelMessage, Kernel } from '@jupyterlab/services';
import { createDeferred, Deferred } from '../../client/common/utils/async';
import { MockPythonService } from './mockPythonService';
import { MockProcessService } from './mockProcessService';
import { concatMultilineString } from '../../client/datascience/common';
import { MockJupyterRequest } from './mockJupyterRequest';

const MockJupyterTimeDelay = 10;
const LineFeedRegEx = /(\r\n|\n)/g

// tslint:disable:no-any no-http-string no-multiline-string max-func-body-length
export class MockJupyterSession implements IJupyterSession {
    private dict: {[index: string] : ICell};
    private restartedEvent: EventEmitter<void> = new EventEmitter<void>();
    private timedelay: number;
    private executionCount: number = 0;
    private outstandingRequestTokenSources: CancellationTokenSource[] = [];

    public get onRestarted() : Event<void> {
        return this.restartedEvent.event;
    }

    public async restart(): Promise<void> {
        // For every outstanding request, switch them to fail mode
        const requests = [...this.outstandingRequestTokenSources];
        requests.forEach(r => r.cancel());
        return sleep(this.timedelay);
    }
    public interrupt(): Promise<void> {
        const requests = [...this.outstandingRequestTokenSources];
        requests.forEach(r => r.cancel());
        return sleep(this.timedelay);
    }
    public waitForIdle(): Promise<void> {
        return sleep(this.timedelay);
    }
    public requestExecute(content: KernelMessage.IExecuteRequest, disposeOnDone?: boolean, metadata?: JSONObject): Kernel.IFuture {
        // Content should have the code
        const cell = this.findCell(content.code);

        // Create a new dummy request
        this.executionCount += 1;
        const tokenSource = new CancellationTokenSource();
        const request = new MockJupyterRequest(cell, this.timedelay, this.executionCount, tokenSource.token);
        this.outstandingRequestTokenSources.push(tokenSource);

        // When it finishes, it should not be an outstanding request anymore
        const removeHandler = () => {
            this.outstandingRequestTokenSources = this.outstandingRequestTokenSources.filter(f => f !== tokenSource);
        };
        request.done.then(() => removeHandler()).catch(() => removeHandler());
        return request;
    }

    dispose(): Promise<void> {
        return Promise.resolve();
    }


    constructor(cellDictionary: {[index: string] : ICell}, timedelay: number) {
        this.dict = cellDictionary;
        this.timedelay = timedelay;
    }

    private findCell = (code : string) : ICell => {
        // Match skipping line separators
        const withoutLines = code.replace(LineFeedRegEx, '');

        if (this.dict.hasOwnProperty(withoutLines)) {
            return this.dict[withoutLines] as ICell;
        }

        console.log(`Cell ${code.splitLines()[0]} not found in mock`);
        throw new Error(`Cell ${code.splitLines()[0]} not found in mock`);
    }

}
