import { BaseAgent, CommandResult } from '../types';

export class GeminiAgent extends BaseAgent {
    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string, opts?: { signal?: AbortSignal }) => Promise<CommandResult>,
        options?: { agentWorkingDir?: string; signal?: AbortSignal }
    ): Promise<string> {
        // Write instruction to a temp file to avoid shell escaping issues with long prompts
        const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
        const promptFile = `/tmp/.prompt-${uniqueId}.md`;
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`echo '${b64}' | base64 -d > ${promptFile}`);

        const command = `gemini -y --sandbox=none --output-format stream-json -p "$(cat ${promptFile})"`;
        const fullCommand = options?.agentWorkingDir ? `cd ${options.agentWorkingDir} && ${command}` : command;
        const result = await runCommand(fullCommand, { signal: options?.signal });

        await runCommand(`rm ${promptFile}`);

        const lines = result.stdout.split('\n');
        const toolCalls: string[] = [];
        let finalResponse = '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const event = JSON.parse(trimmed);
                if (event.type === 'tool_use') {
                    toolCalls.push(trimmed);
                } else if (event.type === 'message') {
                    finalResponse += event.content || event.text || '';
                } else if (event.type === 'result') {
                    finalResponse = event.response || finalResponse;
                }
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Write tool calls to file
        if (toolCalls.length > 0) {
            const toolCallsContent = toolCalls.join('\n');
            const b64Tools = Buffer.from(toolCallsContent).toString('base64');
            await runCommand(`echo '${b64Tools}' | base64 -d > .tool_calls.log`);
        }

        if (result.exitCode !== 0) {
            console.error('GeminiAgent: Gemini CLI failed to execute correctly.');
        }

        return finalResponse || (result.stdout + (result.stderr ? '\n' + result.stderr : ''));
    }
}
