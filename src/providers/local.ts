import * as fs from 'fs-extra';
import * as path from 'path';
import { spawn } from 'child_process';
import { EnvironmentProvider, EnvironmentSetupOpts, CommandResult } from '../types';

export class LocalProvider implements EnvironmentProvider {
    resolveWorkspacePath(filePath: string, workspacePath: string): string {
        let resolved = filePath;
        
        // Expand environment variables like ${VAR}
        resolved = resolved.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, varName) => {
            return process.env[varName] ?? `\${${varName}}`;
        });
        
        // Expand environment variables like $VAR
        resolved = resolved.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, varName) => {
            return process.env[varName] ?? `$${varName}`;
        });

        if (resolved.startsWith('/workspace')) {
            return path.join(workspacePath, resolved.substring('/workspace'.length));
        }
        if (!path.isAbsolute(resolved)) {
            return path.join(workspacePath, resolved);
        }
        return resolved;
    }

    async setup(taskPath: string, skillsPaths: string[], opts: EnvironmentSetupOpts, env?: Record<string, string>): Promise<string> {
        const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
        const tempDir = path.join('/tmp', `skillgrade-${uniqueId}`);
        await fs.ensureDir(tempDir);
        try {
            const stagingDir = path.join(tempDir, '.staging');
            await fs.ensureDir(stagingDir);
            await fs.copy(taskPath, stagingDir);

            // Process workspace mappings
            if (opts.workspace) {
                let inlineFileCount = 0;
                for (const w of opts.workspace) {
                    let srcPath = '';
                    if (w.content !== undefined) {
                        inlineFileCount++;
                        srcPath = path.join(stagingDir, 'workspace_files', `inline_file_${inlineFileCount}.tmp`);
                    } else if (w.src) {
                        srcPath = path.join(stagingDir, path.basename(w.src));
                    }

                    if (srcPath && await fs.pathExists(srcPath)) {
                        const destPath = this.resolveWorkspacePath(w.dest, tempDir);
                        await fs.ensureDir(path.dirname(destPath));
                        await fs.move(srcPath, destPath, { overwrite: true });
                        if (w.chmod) {
                            if (w.chmod === '+x') {
                                const stat = await fs.stat(destPath);
                                await fs.chmod(destPath, stat.mode | 0o111);
                            } else {
                                try {
                                    await fs.chmod(destPath, parseInt(w.chmod, 8));
                                } catch (e) {
                                    console.warn(`[LocalProvider] Failed to apply chmod ${w.chmod} to ${destPath}`);
                                }
                            }
                        }
                    }
                }
            }

            // Move .skillgrade if it exists
            const stagingSkillgrade = path.join(stagingDir, '.skillgrade');
            if (await fs.pathExists(stagingSkillgrade)) {
                await fs.move(stagingSkillgrade, path.join(tempDir, '.skillgrade'), { overwrite: true });
            }

            // Clean up staging area
            await fs.remove(stagingDir);

            // Inject skills into agent discovery paths
            // Gemini: .agents/skills/  |  Claude: .claude/skills/
            if (skillsPaths.length > 0) {
                const homeDir = process.env.HOME || '/root';
                const discoveryDirs = [
                    path.join(homeDir, '.agents', 'skills'),
                    path.join(homeDir, '.claude', 'skills'),
                ];

                console.warn(`[SkillGrade] Injecting skills into ${homeDir}/.agents/skills and .claude/skills`);

                for (const skillsDir of discoveryDirs) {
                    await fs.ensureDir(skillsDir);
                    for (const spath of skillsPaths) {
                        const skillName = path.basename(spath);
                        await fs.copy(spath, path.join(skillsDir, skillName));
                    }
                }
            }

            const setupScriptPath = path.join(tempDir, '.skillgrade', 'scripts', 'setup.sh');
            if (await fs.pathExists(setupScriptPath)) {
                const result = await this.runCommand(tempDir, 'bash .skillgrade/scripts/setup.sh', env);
                if (result.exitCode !== 0) {
                    throw new Error(`Setup commands failed with exit code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
                }
            }

            if (opts.trialSetup) {
                const result = await this.runCommand(tempDir, opts.trialSetup, env);
                if (result.exitCode !== 0) {
                    throw new Error(`Per-trial setup failed with exit code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
                }
            }

            return tempDir;
        } catch (e) {
            await this.cleanup(tempDir);
            throw e;
        }
    }

    async cleanup(workspacePath: string): Promise<void> {
        if (await fs.pathExists(workspacePath)) {
            await fs.remove(workspacePath);
        }
    }

    async runCommand(workspacePath: string, command: string, env?: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<CommandResult> {
        return new Promise((resolve) => {
            const child = spawn(command, {
                shell: true,
                cwd: workspacePath,
                env: { ...process.env, ...env },
                detached: true
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => { stdout += data.toString(); });
            child.stderr.on('data', (data) => { stderr += data.toString(); });

            if (opts?.signal) {
                const onAbort = () => {
                    if (child.pid) {
                        const pid = child.pid;
                        try {
                            process.kill(-pid, 'SIGTERM');
                            setTimeout(() => {
                                try { process.kill(-pid, 'SIGKILL'); } catch (e) {}
                            }, 1000);
                        } catch (e) {}
                    }
                };
                if (opts.signal.aborted) {
                    onAbort();
                } else {
                    opts.signal.addEventListener('abort', onAbort);
                }
            }

            child.on('close', (code) => {
                resolve({ stdout, stderr, exitCode: opts?.signal?.aborted ? 124 : (code ?? 1) });
            });

            child.on('error', () => {
                resolve({ stdout, stderr, exitCode: opts?.signal?.aborted ? 124 : 1 });
            });
        });
    }
}
