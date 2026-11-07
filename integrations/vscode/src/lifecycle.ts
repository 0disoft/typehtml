export interface ManagedClient { start(): Promise<void>; stop(): Promise<void>; dispose(): Promise<void> | void }
const START_TIMEOUT_MS = 10_000;

/** Serialize refreshes so a replacement cannot overlap a client still stopping. */
export class DoctorSessionManager<Plan> {
  private clients: ManagedClient[] = [];
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly create: (plan: Plan) => Promise<ManagedClient>, private readonly report: (error: unknown) => void,
    private readonly startTimeoutMs = START_TIMEOUT_MS) {
    if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 1) throw new Error('Startup deadline must be a positive integer.');
  }

  refresh(plans: readonly Plan[]): Promise<void> {
    const snapshot = [...plans];
    this.pending = this.pending.then(async () => {
      await this.stopAll();
      if (this.disposed) return;
      for (const plan of snapshot) {
        if (this.disposed) break;
        let client: ManagedClient | undefined;
        try {
          client = await this.create(plan);
          this.clients.push(client);
          await this.start(client);
        } catch (error) {
          this.report(error);
          if (client) { this.clients = this.clients.filter((item) => item !== client); await this.close(client); }
        }
      }
    }).catch(this.report);
    return this.pending;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.pending;
    await this.stopAll();
  }

  private async close(client: ManagedClient): Promise<void> {
    try { await client.stop(); } catch (error) { this.report(error); }
    finally { try { await client.dispose(); } catch (error) { this.report(error); } }
  }

  private async start(client: ManagedClient): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([client.start(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('TypeHTML Doctor did not initialize within the startup deadline.')), this.startTimeoutMs);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async stopAll(): Promise<void> {
    const clients = this.clients;
    this.clients = [];
    for (const client of clients) await this.close(client);
  }
}
