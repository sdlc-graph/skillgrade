import { BaseAgent, CommandResult } from '../types';

export class ClaudeAgent extends BaseAgent {
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

        const command = `claude -p --dangerously-skip-permissions "$(cat ${promptFile})"`;
        const fullCommand = options?.agentWorkingDir ? `cd ${options.agentWorkingDir} && ${command}` : command;
        const result = await runCommand(fullCommand, { signal: options?.signal });

        // Clean up prompt file
        await runCommand(`rm ${promptFile}`);

        if (result.exitCode !== 0) {
            console.error('ClaudeAgent: Claude failed to execute correctly.');
        }

        return result.stdout + '\n' + result.stderr;
    }
}
