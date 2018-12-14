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
import { Disposable, Event, EventEmitter } from 'vscode';

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

interface MessageResult {
    message: KernelMessage.IIOPubMessage;
    haveMore: boolean;
}

interface MessageProducer {
    produceNextMessage() : Promise<MessageResult>;
};

class SimpleMessageProducer implements MessageProducer {
    private type: string;
    private result: any;
    private channel: string = 'iopub'

    constructor(type: string, result: any, channel: string = 'iopub') {
        this.type = type;
        this.result = result;
        this.channel = channel;
    }

    public produceNextMessage() : Promise<MessageResult> {
        return new Promise<MessageResult>((resolve, reject) => {
            const message = this.generateMessage(this.type, this.result, this.channel);
            resolve({message: message, haveMore: false});
        });
    }

    protected generateMessage(msgType: string, result: any, channel: string = 'iopub') : KernelMessage.IIOPubMessage {
        return {
            channel: 'iopub',
            header: {
                username: 'foo',
                version: '1.1',
                session: '1111111111',
                msg_id: '1.1',
                msg_type: msgType
            },
            parent_header: {

            },
            metadata: {

            },
            content: result
        };
    }
}

class OutputMessageProducer extends SimpleMessageProducer {

    private output: nbformat.IOutput;
    private cancelToken: CancellationToken;

    constructor(output: nbformat.IOutput, cancelToken: CancellationToken) {
        super(output.output_type, output);
        this.output = output;
        this.cancelToken = cancelToken;
    }

    public async produceNextMessage() : Promise<MessageResult> {
        // Special case the 'generator' cell that returns a function
        // to generate output.
        if (this.output.output_type === 'generator') {
            const resultEntry = <any>this.output['resultGenerator'];
            const resultGenerator = resultEntry as (t: CancellationToken) => Promise<{result: nbformat.IStream, haveMore: boolean}>;
            if (resultGenerator) {
                const streamResult = await resultGenerator(this.cancelToken);
                return {
                    message: this.generateMessage(streamResult.result.output_type, streamResult.result),
                    haveMore: streamResult.haveMore
                };
            }
        }

        return super.produceNextMessage();
    }
}

// tslint:disable:no-any no-http-string no-multiline-string max-func-body-length
export class MockJupyterRequest implements Kernel.IFuture {
    private deferred: Deferred<KernelMessage.IShellMessage> = createDeferred<KernelMessage.IShellMessage>();
    private failing = false;
    private executionCount: number;
    private cell: ICell;
    private cancelToken: CancellationToken;
    public msg: KernelMessage.IShellMessage;
    public onReply: (msg: KernelMessage.IShellMessage) => void | PromiseLike<void>;
    public onStdin: (msg: KernelMessage.IStdinMessage) => void | PromiseLike<void>;
    public onIOPub: (msg: KernelMessage.IIOPubMessage) => void | PromiseLike<void>;

    constructor(cell: ICell, delay: number, executionCount: number, cancelToken: CancellationToken) {
        // Save our execution count, this is like our id
        this.executionCount = executionCount;
        this.cell = cell;
        this.cancelToken = cancelToken;

        // Start our sequence of events that is our cell running
        this.executeRequest(delay);
    }

    public get done() : Promise<KernelMessage.IShellMessage> {
        return this.deferred.promise;
    }
    public registerMessageHook(hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>): void {
    }
    public removeMessageHook(hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>): void {
    }
    public sendInputReply(content: KernelMessage.IInputReply): void {
    }
    public isDisposed: boolean;
    public dispose(): void {
        if (!this.isDisposed) {
            this.isDisposed = true;
        }
    }
    public switchToFail() {
        this.failing = true;
    }

    public interrupt() {
        this.failing = true;
    }

    private executeRequest(delay: number) {
        // The order of messages should be:
        // 1 - Status busy
        // 2 - Execute input
        // 3 - N - Results/output
        // N + 1 - Status idle

        // Create message producers for output first.
        const outputs = this.cell.data.outputs as nbformat.IOutput[];
        const outputProducers = outputs.map(o => new OutputMessageProducer(o, this.cancelToken));

        // Then combine those into an array of producers for the rest of the messages
        const producers = [
            new SimpleMessageProducer('status', { execution_state: 'busy'}),
            new SimpleMessageProducer('execute_input', { code: concatMultilineString(this.cell.data.source), execution_count: this.executionCount }),
            ...outputProducers,
            new SimpleMessageProducer('status', { execution_state: 'idle'})
        ]

        // Then send these until we're done
        this.sendMessages(producers, delay);
    }

    private sendMessages(producers: MessageProducer[], delay: number) {
        if (producers && producers.length > 0) {
            // We have another producer, after a delay produce the next
            // message
            const producer = producers[0];
            setTimeout(() => {
                // Produce the next message
                producer.produceNextMessage().then(r => {
                    // If there's a message, send it.
                    if (r.message && this.onIOPub) {
                        this.onIOPub(r.message);
                    }

                    // Move onto the next producer if allowed
                    if (r.haveMore) {
                        this.sendMessages(producers, delay);
                    } else {
                        this.sendMessages(producers.slice(1), delay);
                    }
                })
            }, delay);
        } else {
            // No more messages, create a simple producer for our shell message
            const shellProducer = new SimpleMessageProducer('done', {status: 'success'}, 'shell');
            shellProducer.produceNextMessage().then((r) => {
                this.deferred.resolve(<any>r.message as KernelMessage.IShellMessage);
            });
        }
    }
}
