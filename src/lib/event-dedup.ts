// Remembers what history.jsonl already drew so the SSE stream, which resends
// its whole recent-event buffer on a fresh connect, doesn't draw it again.
//
// Two checks, because user_message lines are stored in history without an
// event id while the stream gives them one (`<ms>-user`):
// - ids seen in history
// - stream ids whose millisecond prefix is at or before the newest history
//   event (history is written at the same moment an event is emitted, and
//   both stamps come from the server's clock)
export class EventDedup {
  private seen = new Set<string>();
  private cutoff = -Infinity;

  markSeen(id: string | number | null | undefined): void {
    if (id != null && id !== '') this.seen.add(String(id));
  }

  setCutoff(ms: number): void {
    if (Number.isFinite(ms)) this.cutoff = Math.max(this.cutoff, ms);
  }

  isDuplicate(id: string | number | null | undefined): boolean {
    if (id == null || id === '') return false;
    const s = String(id);
    if (this.seen.has(s)) return true;
    const m = /^(\d{10,})-/.exec(s);
    return !!m && Number(m[1]) <= this.cutoff;
  }

  reset(): void {
    this.seen.clear();
    this.cutoff = -Infinity;
  }
}
