import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LaunchPlan } from './config';

/** Own the transport process instead of relying on a client's delayed spawn. */
export class DoctorProcess {
  private closed = false;
  private child: ChildProcessWithoutNullStreams | undefined;
  private exited: Promise<void> | undefined;

  constructor(private readonly plan: Pick<LaunchPlan, 'command' | 'args' | 'root'>) {}

  async launch(): Promise<ChildProcessWithoutNullStreams> {
    if (this.closed || this.child) throw new Error('TypeHTML Doctor transport is closed or already started.');
    const child = spawn(this.plan.command, [...this.plan.args], { cwd: this.plan.root, shell: false, windowsHide: true, stdio: 'pipe' });
    this.child = child;
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (this.closed) throw new Error('TypeHTML Doctor transport closed during startup.');
    return child;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) child.kill('SIGKILL');
    await this.exited;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    this.child = undefined;
  }
}
