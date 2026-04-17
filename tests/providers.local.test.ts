import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsReal from 'fs';
import * as fsExtra from 'fs-extra';
import { LocalProvider } from '../src/providers/local';

describe('LocalProvider', () => {
  const provider = new LocalProvider();
  let tempDirs: string[] = [];
  let originalHome: string | undefined;
  let mockHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    mockHome = path.join(os.tmpdir(), `skillgrade-mock-home-${Date.now()}`);
    await fsExtra.ensureDir(mockHome);
    process.env.HOME = mockHome;
    tempDirs.push(mockHome);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    for (const dir of tempDirs) {
      try { await fsExtra.remove(dir); } catch {}
    }
    tempDirs = [];
  });

  describe('setup', () => {
    it('creates a temp directory and copies task files', async () => {
      // Create a real temp task directory
      const taskDir = path.join(os.tmpdir(), `skillgrade-test-task-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      await fsExtra.writeFile(path.join(taskDir, 'task.toml'), 'version = "1"');
      tempDirs.push(taskDir);

      const taskConfig = {
        version: '1',
        metadata: { author_name: '', author_email: '', difficulty: 'medium', category: '', tags: [] },
        graders: [],
        agent: { timeout_sec: 300 },
        environment: { build_timeout_sec: 180, cpus: 2, memory_mb: 2048, storage_mb: 500 },
      };

      const workspace = await provider.setup(taskDir, [], taskConfig as any);
      tempDirs.push(workspace);

      expect(workspace).toContain('skillgrade-');
      expect(await fsExtra.pathExists(workspace)).toBe(true);
      expect(await fsExtra.pathExists(path.join(workspace, 'task.toml'))).toBe(true);
    });

    it('injects skills into discovery directories', async () => {
      const taskDir = path.join(os.tmpdir(), `skillgrade-test-task-${Date.now()}`);
      const skillDir = path.join(os.tmpdir(), `skillgrade-test-skill-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      await fsExtra.ensureDir(skillDir);
      await fsExtra.writeFile(path.join(skillDir, 'SKILL.md'), '# Test Skill');
      tempDirs.push(taskDir, skillDir);

      const taskConfig = {
        version: '1',
        metadata: { author_name: '', author_email: '', difficulty: 'medium', category: '', tags: [] },
        graders: [],
        agent: { timeout_sec: 300 },
        environment: { build_timeout_sec: 180, cpus: 2, memory_mb: 2048, storage_mb: 500 },
      };

      const workspace = await provider.setup(taskDir, [skillDir], taskConfig as any);
      tempDirs.push(workspace);

      const skillName = path.basename(skillDir);
      // Check Gemini discovery path
      const geminiPath = path.join(mockHome, '.agents', 'skills', skillName, 'SKILL.md');
      expect(await fsExtra.pathExists(geminiPath)).toBe(true);

      // Check Claude discovery path
      const claudePath = path.join(mockHome, '.claude', 'skills', skillName, 'SKILL.md');
      expect(await fsExtra.pathExists(claudePath)).toBe(true);
    });

    it('cleans up temp directory if trialSetup fails', async () => {
      const taskDir = path.join(os.tmpdir(), `skillgrade-test-task-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      tempDirs.push(taskDir);

      const taskConfig = {
        version: '1',
        graders: [],
        agent: { timeout_sec: 300 },
        environment: { cpus: 2, memory_mb: 2048 },
        trialSetup: 'false',
      };

      const spyCleanup = vi.spyOn(provider, 'cleanup');

      await expect(provider.setup(taskDir, [], taskConfig as any)).rejects.toThrow('Per-trial setup failed');

      expect(spyCleanup).toHaveBeenCalled();
      const calledWithPath = spyCleanup.mock.calls[0][0];
      expect(await fsExtra.pathExists(calledWithPath)).toBe(false);
    });

    it('executes scripts/setup.sh if it exists', async () => {
      const taskDir = path.join(os.tmpdir(), `skillgrade-test-task-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      await fsExtra.ensureDir(path.join(taskDir, 'scripts'));
      await fsExtra.writeFile(path.join(taskDir, 'scripts', 'setup.sh'), '#!/bin/bash\necho "setup executed" > setup_done.txt');
      tempDirs.push(taskDir);

      const taskConfig = {
        version: '1',
        graders: [],
        agent: { timeout_sec: 300 },
        environment: { cpus: 2, memory_mb: 2048 },
      };

      const workspace = await provider.setup(taskDir, [], taskConfig as any);
      tempDirs.push(workspace);

      expect(await fsExtra.pathExists(path.join(workspace, 'setup_done.txt'))).toBe(true);
      const content = await fsExtra.readFile(path.join(workspace, 'setup_done.txt'), 'utf-8');
      expect(content.trim()).toBe('setup executed');
    });

    it('processes workspace mappings and resolves /workspace prefix', async () => {
      const taskDir = path.join(os.tmpdir(), `skillgrade-test-task-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      
      // Simulate prepareTempTaskDir behavior
      await fsExtra.ensureDir(path.join(taskDir, 'workspace_files'));
      await fsExtra.writeFile(path.join(taskDir, 'workspace_files', 'inline_file_1.tmp'), 'content 1');
      await fsExtra.writeFile(path.join(taskDir, 'foo.txt'), 'content 2');
      tempDirs.push(taskDir);

      const taskConfig = {
        version: '1',
        graders: [],
        agent: { timeout_sec: 300 },
        environment: { cpus: 2, memory_mb: 2048 },
        workspace: [
          { content: 'content 1', dest: '/workspace/sub/file1.txt' },
          { src: 'foo.txt', dest: 'file2.txt' }
        ]
      };

      const workspace = await provider.setup(taskDir, [], taskConfig as any);
      tempDirs.push(workspace);

      expect(await fsExtra.readFile(path.join(workspace, 'sub', 'file1.txt'), 'utf-8')).toBe('content 1');
      expect(await fsExtra.readFile(path.join(workspace, 'file2.txt'), 'utf-8')).toBe('content 2');
    });
  });

  describe('resolveWorkspacePath', () => {
    it('resolves /workspace prefix to workspace path', () => {
      const workspacePath = '/tmp/skillgrade-xyz';
      const resolved = provider.resolveWorkspacePath('/workspace/foo/bar', workspacePath);
      expect(resolved).toBe('/tmp/skillgrade-xyz/foo/bar');
    });

    it('leaves non-/workspace paths as is', () => {
      const workspacePath = '/tmp/skillgrade-xyz';
      const resolved = provider.resolveWorkspacePath('/tmp/foo', workspacePath);
      expect(resolved).toBe('/tmp/foo');
    });

    it('expands environment variables in paths', () => {
      const workspacePath = '/tmp/skillgrade-xyz';
      process.env.FOO = 'bar';
      process.env.BAZ = 'qux';
      
      const resolved1 = provider.resolveWorkspacePath('$FOO/file.txt', workspacePath);
      expect(resolved1).toBe('/tmp/skillgrade-xyz/bar/file.txt');

      const resolved2 = provider.resolveWorkspacePath('${BAZ}/file.txt', workspacePath);
      expect(resolved2).toBe('/tmp/skillgrade-xyz/qux/file.txt');
      
      delete process.env.FOO;
      delete process.env.BAZ;
    });
  });

  describe('cleanup', () => {
    it('removes the workspace directory', async () => {
      const tempDir = path.join(os.tmpdir(), `skillgrade-cleanup-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      await fsExtra.writeFile(path.join(tempDir, 'file.txt'), 'test');

      await provider.cleanup(tempDir);
      expect(await fsExtra.pathExists(tempDir)).toBe(false);
    });

    it('handles non-existent directory gracefully', async () => {
      // Should not throw
      await provider.cleanup('/tmp/nonexistent-dir-' + Date.now());
    });
  });

  describe('runCommand', () => {
    it('executes a command and captures stdout', async () => {
      const tempDir = path.join(os.tmpdir(), `skillgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(tempDir, 'echo "hello world"');
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.exitCode).toBe(0);
    });

    it('captures stderr', async () => {
      const tempDir = path.join(os.tmpdir(), `skillgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(tempDir, 'echo "error" >&2');
      expect(result.stderr.trim()).toBe('error');
    });

    it('returns non-zero exit code', async () => {
      const tempDir = path.join(os.tmpdir(), `skillgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(tempDir, 'exit 42');
      expect(result.exitCode).toBe(42);
    });

    it('passes environment variables', async () => {
      const tempDir = path.join(os.tmpdir(), `skillgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(tempDir, 'echo $TEST_VAR', { TEST_VAR: 'test_value' });
      expect(result.stdout.trim()).toBe('test_value');
    });

    it('runs command in the correct working directory', async () => {
      const tempDir = path.join(os.tmpdir(), `skillgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(tempDir, 'pwd');
      // The path might have /private prefix on macOS
      expect(result.stdout.trim()).toContain(path.basename(tempDir));
    });
  });
});
