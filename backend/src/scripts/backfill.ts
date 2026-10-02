#!/usr/bin/env tsx
/**
 * Resumable backfill/recovery script for ledger ingestion outages (#728).
 *
 * Usage:
 *   pnpm backfill                    # Resume from last checkpoint
 *   pnpm backfill --status           # Show current gap
 *   pnpm backfill --verify           # Verify checkpoint consistency
 *   pnpm backfill --from 1000000     # Override start ledger
 *   pnpm backfill --to 1050000       # Override end ledger
 *   pnpm backfill --dry-run          # Simulate without writes
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../logger.js';
import { env } from '../env.js';

const BATCH_SIZE = 100; // Events per batch
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

interface BackfillOptions {
  fromLedger?: string;
  toLedger?: string;
  status?: boolean;
  verify?: boolean;
  dryRun?: boolean;
  resetCheckpoint?: string;
}

interface SorobanEvent {
  id: string;
  ledger: bigint;
  tx_hash: string;
  event_type: string;
  payload: unknown;
  timestamp: Date;
}

/**
 * Parse CLI arguments.
 */
function parseArgs(args: string[]): BackfillOptions {
  const options: BackfillOptions = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--from' && i + 1 < args.length) {
      options.fromLedger = args[++i];
    } else if (arg === '--to' && i + 1 < args.length) {
      options.toLedger = args[++i];
    } else if (arg === '--status') {
      options.status = true;
    } else if (arg === '--verify') {
      options.verify = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--reset-checkpoint' && i + 1 < args.length) {
      options.resetCheckpoint = args[++i];
    }
  }
  
  return options;
}

/**
 * Fetch events from Soroban RPC for a ledger range.
 * Note: This is a simplified mock. Real implementation would use Stellar SDK.
 */
async function fetchEventsBatch(
  startLedger: bigint,
  endLedger: bigint
): Promise<SorobanEvent[]> {
  logger.debug('Fetching events', {
    from: startLedger.toString(),
    to: endLedger.toString(),
  });
  
  // TODO: Replace with real Stellar RPC call
  // const rpc = new StellarRpc.Server(env.RPC_ENDPOINT);
  // const response = await rpc.getEvents({
  //   startLedger: startLedger.toString(),
  //   endLedger: endLedger.toString(),
  //   filters: [{ contractIds: [env.DRIP_POOL_CONTRACT_ID] }],
  // });
  
  // Mock: return empty array for now
  return [];
}

/**
 * Fetch events with exponential backoff retry.
 */
async function fetchEventsWithRetry(
  startLedger: bigint,
  endLedger: bigint,
  maxRetries = MAX_RETRIES
): Promise<SorobanEvent[]> {
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      return await fetchEventsBatch(startLedger, endLedger);
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) {
        logger.error('Max retries exceeded', { error });
        throw error;
      }
      
      const delay = Math.pow(2, attempt) * RETRY_DELAY_MS;
      logger.warn('RPC fetch failed, retrying', {
        attempt,
        delay,
        error: error instanceof Error ? error.message : String(error),
      });
      
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  
  throw new Error('Unexpected: retry loop exited without return');
}

/**
 * Process a single event (idempotent).
 */
async function processEvent(
  prisma: PrismaClient,
  event: SorobanEvent,
  dryRun: boolean
): Promise<void> {
  const { tx_hash, event_type, payload } = event;
  
  if (dryRun) {
    logger.info('DRY RUN: Would process event', {
      tx_hash,
      event_type,
      ledger: event.ledger.toString(),
    });
    return;
  }
  
  // Idempotent upsert based on tx_hash
  // TODO: Implement actual event processing logic per event type
  logger.debug('Processing event', {
    tx_hash,
    event_type,
    ledger: event.ledger.toString(),
  });
  
  // Example: deposit event
  if (event_type === 'deposit') {
    await prisma.actionLedger.upsert({
      where: { txHash: tx_hash },
      create: {
        txHash: tx_hash,
        walletAddress: (payload as any)?.who ?? 'unknown',
        actionType: 'deposit',
        status: 'confirmed',
        actionPayload: payload as any,
      },
      update: {
        status: 'confirmed',
        updatedAt: new Date(),
      },
    });
  }
  
  // ... handle other event types
}

/**
 * Process events and update checkpoint transactionally.
 */
async function processEventWithCheckpoint(
  prisma: PrismaClient,
  event: SorobanEvent,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    await processEvent(prisma, event, dryRun);
    return;
  }
  
  await prisma.$transaction(async (tx) => {
    // 1. Process event
    await processEvent(tx as any, event, false);
    
    // 2. Update checkpoint atomically
    await tx.indexerCheckpoint.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        latestLedger: event.ledger,
        lastProcessedEventId: event.id,
        lastSyncTime: new Date(),
        lastSuccessSyncTime: new Date(),
        lastError: null,
      },
      update: {
        latestLedger: event.ledger,
        lastProcessedEventId: event.id,
        lastSyncTime: new Date(),
        lastSuccessSyncTime: new Date(),
        lastError: null,
      },
    });
  });
}

/**
 * Get latest ledger from Soroban RPC.
 */
async function getLatestLedger(): Promise<bigint> {
  // TODO: Replace with real Stellar RPC call
  // const rpc = new StellarRpc.Server(env.RPC_ENDPOINT);
  // const latest = await rpc.getLatestLedger();
  // return BigInt(latest.sequence);
  
  // Mock: return a high number
  return 2000000n;
}

/**
 * Verify checkpoint consistency with actual processed events.
 */
async function verifyCheckpointConsistency(
  prisma: PrismaClient
): Promise<boolean> {
  const checkpoint = await prisma.indexerCheckpoint.findUnique({
    where: { id: 1 },
  });
  
  if (!checkpoint) {
    logger.warn('No checkpoint found');
    return false;
  }
  
  // Find max ledger in actual processed events
  const maxProcessed = await prisma.actionLedger.aggregate({
    _max: { ledgerSequence: true },
  });
  
  if (!maxProcessed._max.ledgerSequence) {
    logger.info('No events processed yet, checkpoint is consistent');
    return true;
  }
  
  const gap =
    checkpoint.latestLedger - BigInt(maxProcessed._max.ledgerSequence);
  
  if (gap > 1000n) {
    logger.error('Checkpoint inconsistency detected', {
      checkpoint_ledger: checkpoint.latestLedger.toString(),
      max_processed_ledger: maxProcessed._max.ledgerSequence.toString(),
      gap: gap.toString(),
    });
    return false;
  }
  
  logger.info('Checkpoint is consistent', {
    checkpoint_ledger: checkpoint.latestLedger.toString(),
    max_processed_ledger: maxProcessed._max.ledgerSequence.toString(),
  });
  
  return true;
}

/**
 * Show backfill status.
 */
async function showStatus(prisma: PrismaClient): Promise<void> {
  const checkpoint = await prisma.indexerCheckpoint.findUnique({
    where: { id: 1 },
  });
  
  if (!checkpoint) {
    logger.info('No checkpoint found. Run initial sync first.');
    return;
  }
  
  const latestLedger = await getLatestLedger();
  const gap = latestLedger - checkpoint.latestLedger;
  const gapHours = (Number(gap) * 5) / 3600; // ~5s per ledger
  
  logger.info('Backfill status', {
    current_checkpoint: checkpoint.latestLedger.toString(),
    latest_ledger: latestLedger.toString(),
    gap: gap.toString(),
    gap_hours: gapHours.toFixed(1),
    last_sync: checkpoint.lastSyncTime.toISOString(),
    last_error: checkpoint.lastError,
  });
}

/**
 * Main backfill function.
 */
async function backfill(options: BackfillOptions): Promise<void> {
  const prisma = new PrismaClient();
  
  try {
    // Status check only
    if (options.status) {
      await showStatus(prisma);
      return;
    }
    
    // Verify checkpoint consistency
    if (options.verify) {
      const isConsistent = await verifyCheckpointConsistency(prisma);
      if (!isConsistent) {
        logger.error('Checkpoint verification failed. Consider resetting checkpoint.');
        process.exit(1);
      }
      return;
    }
    
    // Reset checkpoint if requested
    if (options.resetCheckpoint) {
      const resetLedger = BigInt(options.resetCheckpoint);
      await prisma.indexerCheckpoint.update({
        where: { id: 1 },
        data: {
          latestLedger: resetLedger,
          lastSyncTime: new Date(),
        },
      });
      logger.info('Checkpoint reset', { ledger: resetLedger.toString() });
      return;
    }
    
    // Load checkpoint
    const checkpoint = await prisma.indexerCheckpoint.findUnique({
      where: { id: 1 },
    });
    
    if (!checkpoint && !options.fromLedger) {
      throw new Error('No checkpoint found. Use --from to specify start ledger.');
    }
    
    const startLedger = options.fromLedger
      ? BigInt(options.fromLedger)
      : checkpoint
        ? checkpoint.latestLedger + 1n
        : 1n;
    
    const targetLedger = options.toLedger
      ? BigInt(options.toLedger)
      : await getLatestLedger();
    
    logger.info('Starting backfill', {
      from: startLedger.toString(),
      to: targetLedger.toString(),
      gap: (targetLedger - startLedger).toString(),
      dry_run: options.dryRun ?? false,
    });
    
    let currentLedger = startLedger;
    let totalEventsProcessed = 0;
    const startTime = Date.now();
    
    // Process in batches
    while (currentLedger < targetLedger) {
      const batchEnd =
        currentLedger + BigInt(BATCH_SIZE) < targetLedger
          ? currentLedger + BigInt(BATCH_SIZE)
          : targetLedger;
      
      const events = await fetchEventsWithRetry(currentLedger, batchEnd);
      
      logger.info('Processing batch', {
        from: currentLedger.toString(),
        to: batchEnd.toString(),
        events: events.length,
      });
      
      // Process each event with transactional checkpoint update
      for (const event of events) {
        await processEventWithCheckpoint(prisma, event, options.dryRun ?? false);
        totalEventsProcessed++;
      }
      
      currentLedger = batchEnd;
      
      // Progress logging every 10 batches
      if (Number(currentLedger - startLedger) % (BATCH_SIZE * 10) === 0) {
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const progressPct =
          ((currentLedger - startLedger) * 100n) / (targetLedger - startLedger);
        
        logger.info('Backfill progress', {
          current_ledger: currentLedger.toString(),
          target_ledger: targetLedger.toString(),
          progress_pct: progressPct.toString(),
          events_processed: totalEventsProcessed,
          elapsed_seconds: elapsedSeconds.toFixed(1),
          events_per_second: (totalEventsProcessed / elapsedSeconds).toFixed(2),
        });
      }
    }
    
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    logger.info('Backfill complete', {
      final_ledger: currentLedger.toString(),
      total_events: totalEventsProcessed,
      elapsed_seconds: elapsedSeconds.toFixed(1),
      events_per_second: (totalEventsProcessed / elapsedSeconds).toFixed(2),
    });
  } catch (error) {
    logger.error('Backfill failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  
  backfill(options)
    .then(() => {
      logger.info('Backfill script finished successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Backfill script failed', { error });
      process.exit(1);
    });
}

export { backfill, verifyCheckpointConsistency, showStatus };
