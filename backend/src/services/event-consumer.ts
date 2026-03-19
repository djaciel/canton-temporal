// =============================================================================
// Event Consumer — HTTP polling + PostgreSQL projection
//
// Polls Canton's /v2/updates/flats every POLLING_INTERVAL_MS (default 2s),
// parses Transaction updates, and projects them to PostgreSQL:
//   - CreatedEvent  → INSERT contract_events + INSERT active_contracts
//   - ExercisedEvent (consuming) → INSERT contract_events + DELETE active_contracts
//
// Key decisions:
//   - DEC-002: Manual projection replaces PQS (Enterprise-only)
//   - DEC-003: HTTP polling, no WebSocket (not available in Canton 3.4.x)
//   - DEC-017: Requires OIDC token — uses bot user via TokenProvider
//   - DEC-019: One consumer per participant, canReadAs local party only
//
// The consumer survives restarts by reading last_offset from consumer_state.
// All events within a single Canton transaction are processed atomically
// in one SQL transaction.
// =============================================================================

import { config } from '../config.js';
import { TokenProvider } from './token-provider.js';
import { getUpdates } from './ledger-client.js';
import { getLastOffset, processTransactionEvents } from '../db/queries.js';

export class EventConsumer {
  private tokenProvider: TokenProvider;
  private lastOffset: number | null = null;
  private party: string | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private resolveParty: (token: string) => Promise<string>;

  constructor(resolveParty: (token: string) => Promise<string>) {
    this.tokenProvider = new TokenProvider(config.botUsername, config.botPassword);
    this.resolveParty = resolveParty;
  }

  /** Start the polling loop. */
  start(): void {
    if (this.intervalId) return;
    console.log(`[event-consumer] Starting polling every ${config.pollingIntervalMs}ms`);
    // Fire immediately, then repeat on interval
    this.pollOnce();
    this.intervalId = setInterval(() => this.pollOnce(), config.pollingIntervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[event-consumer] Stopped');
  }

  /** Execute a single poll cycle. Safe to call externally (for testing). */
  async pollOnce(): Promise<void> {
    if (this.polling) return; // prevent overlapping polls
    this.polling = true;

    try {
      const token = await this.tokenProvider.getToken();

      // Resolve party on first poll
      if (!this.party) {
        this.party = await this.resolveParty(token);
        console.log(`[event-consumer] Resolved party: ${this.party}`);
      }

      // Read last offset from DB on first poll (AC: survives restart)
      if (this.lastOffset === null) {
        this.lastOffset = await getLastOffset();
        console.log(`[event-consumer] Resuming from offset ${this.lastOffset}`);
      }

      const updates = await getUpdates(token, this.party, this.lastOffset);

      for (const update of updates) {
        if (update.type === 'transaction' && update.events && update.events.length > 0) {
          await processTransactionEvents(
            update.events,
            update.offset,
            new Date().toISOString(),
          );
          this.lastOffset = update.offset;
        }
        // OffsetCheckpoint: we don't process contract logic, but track offset
        // to avoid re-fetching old checkpoints
        if (update.type === 'checkpoint') {
          this.lastOffset = Math.max(this.lastOffset, update.offset);
        }
      }
    } catch (err) {
      console.error('[event-consumer] Poll error:', (err as Error).message);
      // Do not throw — the loop continues on next interval
    } finally {
      this.polling = false;
    }
  }
}
