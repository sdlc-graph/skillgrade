import { BaseAgent, CommandResult } from '../types';

export class ClaudeAgent extends BaseAgent {
    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string, opts?: { signal?: AbortSignal }) => Promise<CommandResult>,
        options?: { agentWorkingDir?: string; signal?: AbortSignal }
    ): Promise<string> {
        // Write instruction to a temp file to avoid shell escaping issues with long prompts
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`echo '${b64}' | base64 -d > /tmp/.prompt.md`);

        const command = `claude -p --dangerously-skip-permissions "$(cat /tmp/.prompt.md)"`;
        const fullCommand = options?.agentWorkingDir ? `cd ${options.agentWorkingDir} && ${command}` : command;
        const result = await runCommand(fullCommand, { signal: options?.signal });

        if (result.exitCode !== 0) {
            console.error('ClaudeAgent: Claude failed to execute correctly.');
        }

        return result.stdout + '\n' + result.stderr;
    }
}
