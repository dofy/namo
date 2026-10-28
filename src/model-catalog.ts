export interface CatalogModel { id: string; name: string; isDefault: boolean }

/** A stale catalog remains useful when discovery fails; discovery never blocks inbox acceptance. */
export class ModelCatalog {
  private entries: CatalogModel[] = [];
  private attemptedSignature?: string;
  private nextAttempt = 0;
  private pending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private load: () => Promise<CatalogModel[]>, private signature: () => string,
    private now: () => number = Date.now) {}

  get models(): readonly CatalogModel[] { return this.entries; }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    let signature: string;
    try { signature = this.signature(); }
    catch { return Promise.resolve(); }
    if (signature === this.attemptedSignature && this.now() < this.nextAttempt) return Promise.resolve();
    this.attemptedSignature = signature;
    this.pending = Promise.resolve().then(() => this.load()).then(models => {
      // A CLI switch during discovery invalidates the result from the old binary.
      if (!this.stopped && this.signature() === signature) {
        this.entries = models;
        this.nextAttempt = this.now() + 5 * 60_000;
      }
    }).catch(() => {
      this.nextAttempt = this.now() + 30_000;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 30_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer); this.timer = undefined;
    await this.pending;
  }
}
