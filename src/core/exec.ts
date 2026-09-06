import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
}

export interface Exec {
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
}

export class RealExec implements Exec {
  run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => resolve({ code: 127, stdout, stderr: err.message }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (opts.input !== undefined) child.stdin.write(opts.input);
      child.stdin.end();
    });
  }
}

interface FakeRule {
  cmd: string;
  argPrefix: string[];
  result: Partial<ExecResult>;
}

export class FakeExec implements Exec {
  readonly calls: { cmd: string; args: string[]; opts: ExecOptions | undefined }[] = [];
  private readonly rules: FakeRule[] = [];

  on(cmd: string, argPrefix: string[], result: Partial<ExecResult>): this {
    this.rules.push({ cmd, argPrefix, result });
    return this;
  }

  async run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, args, opts });
    // Last matching rule wins so tests can override earlier defaults.
    const rule = [...this.rules].reverse().find(
      (r) => r.cmd === cmd && r.argPrefix.every((p, i) => args[i] === p),
    );
    if (!rule) return { code: 127, stdout: '', stderr: `FakeExec: no rule for ${cmd} ${args.join(' ')}` };
    return { code: 0, stdout: '', stderr: '', ...rule.result };
  }
}
