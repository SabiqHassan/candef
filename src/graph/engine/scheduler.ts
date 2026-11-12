/** Coalesces invalidations, runs only while requested or while step reports motion. */
export class RenderScheduler {
  private pending: number | null = null;
  private stopped = false;
  private disposed = false;
  constructor(
    private request: (cb: (time: number) => void) => number,
    private cancel: (id: number) => void,
    private step: (time: number) => boolean,
  ) {}
  invalidate(): void {
    if (this.disposed || this.stopped || this.pending !== null) return;
    this.pending = this.request((time) => {
      this.pending = null;
      if (this.disposed || this.stopped) return;
      if (this.step(time)) this.invalidate();
    });
  }
  suspend(): void {
    this.stopped = true;
    if (this.pending !== null) this.cancel(this.pending);
    this.pending = null;
  }
  resume(): void {
    if (this.disposed) return;
    this.stopped = false;
    this.invalidate();
  }
  dispose(): void {
    if (this.disposed) return;
    this.suspend();
    this.disposed = true;
  }
}
