/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * Tests for dead-letter queue reference implementations.
 * Issue #298: Provide FileDeadLetterQueue and InMemoryDeadLetterQueue.
 */

import {
  InMemoryDeadLetterQueue,
  FileDeadLetterQueue,
  type DeadLetterEvent,
} from '../src/deadLetterQueue';
import * as fs from 'fs';
import * as path from 'path';

type MockRawContractEvent = {
  id: string;
  contractId: string;
  ledger: number;
  topic: string[];
  value: unknown;
};

describe('InMemoryDeadLetterQueue', () => {
  let dlq: InMemoryDeadLetterQueue;

  beforeEach(() => {
    dlq = new InMemoryDeadLetterQueue();
  });

  it('stores failed events in memory', async () => {
    const event: MockRawContractEvent = {
      id: 'evt-1',
      contractId: 'CDENYLISTGATE',
      ledger: 100,
      topic: ['denylist_added'],
      value: { address: 'address-1' },
    };

    const error = new Error('Processing failed');

    await dlq.enqueue(event, error);

    const stored = dlq.getAll();
    expect(stored).toHaveLength(1);
    expect(stored[0].event).toEqual(event);
    expect(stored[0].error.message).toBe('Processing failed');
  });

  it('preserves insertion order (FIFO)', async () => {
    const events = [
      { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} },
      { id: 'evt-2', contractId: 'C2', ledger: 2, topic: ['t2'], value: {} },
      { id: 'evt-3', contractId: 'C3', ledger: 3, topic: ['t3'], value: {} },
    ];

    for (const event of events) {
      await dlq.enqueue(event, new Error('test'));
    }

    const stored = dlq.getAll();
    expect(stored.map((entry) => entry.event.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('allows removing specific events by ID', async () => {
    const event1 = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
    const event2 = { id: 'evt-2', contractId: 'C2', ledger: 2, topic: ['t2'], value: {} };

    await dlq.enqueue(event1, new Error('fail'));
    await dlq.enqueue(event2, new Error('fail'));

    const removed = await dlq.remove('evt-1');
    expect(removed).toBe(true);

    const remaining = dlq.getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event.id).toBe('evt-2');
  });

  it('returns false when removing a non-existent event', async () => {
    const removed = await dlq.remove('nonexistent');
    expect(removed).toBe(false);
  });

  it('supports clearing all events', async () => {
    const event1 = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
    const event2 = { id: 'evt-2', contractId: 'C2', ledger: 2, topic: ['t2'], value: {} };

    await dlq.enqueue(event1, new Error('fail'));
    await dlq.enqueue(event2, new Error('fail'));

    expect(dlq.getAll()).toHaveLength(2);

    await dlq.clear();

    expect(dlq.getAll()).toHaveLength(0);
  });

  it('encodes error details for later inspection', async () => {
    const event = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
    const error = new Error('Custom error message');

    await dlq.enqueue(event, error);

    const stored = dlq.getAll();
    expect(stored[0].error.message).toBe('Custom error message');
    expect(stored[0].error.stack).toBeDefined();
  });

  it('records timestamp for each queued event', async () => {
    const event = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
    const beforeEnqueue = Date.now();

    await dlq.enqueue(event, new Error('fail'));

    const afterEnqueue = Date.now();
    const stored = dlq.getAll();

    const timestamp = new Date(stored[0].timestamp).getTime();
    expect(timestamp).toBeGreaterThanOrEqual(beforeEnqueue);
    expect(timestamp).toBeLessThanOrEqual(afterEnqueue);
  });

  it('getAll returns a copy, not a reference', async () => {
    const event = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
    await dlq.enqueue(event, new Error('fail'));

    const firstGet = dlq.getAll();
    const secondGet = dlq.getAll();

    expect(firstGet).not.toBe(secondGet);
    expect(firstGet).toEqual(secondGet);
  });
});

describe('FileDeadLetterQueue', () => {
  let dlq: FileDeadLetterQueue;
  let tmpDir: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    tmpDir = path.join(__dirname, '..', '.test-dlq-temp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const filePath = path.join(tmpDir, `dlq-${Date.now()}.jsonl`);
    dlq = new FileDeadLetterQueue(filePath);
  });

  afterEach(() => {
    // Cleanup: remove test files
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        fs.unlinkSync(path.join(tmpDir, file));
      }
      fs.rmdirSync(tmpDir);
    }
  });

  it('persists failed events to disk in JSONL format', async () => {
    const event = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };

    await dlq.enqueue(event, new Error('Processing failed'));

    // Read the file directly
    const content = fs.readFileSync(dlq.getFilePath(), 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.event.id).toBe('evt-1');
    expect(parsed.error.message).toBe('Processing failed');
  });

  it('appends multiple events to file in order', async () => {
    const events = [
      { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} },
      { id: 'evt-2', contractId: 'C2', ledger: 2, topic: ['t2'], value: {} },
      { id: 'evt-3', contractId: 'C3', ledger: 3, topic: ['t3'], value: {} },
    ];

    for (const event of events) {
      await dlq.enqueue(event, new Error('fail'));
    }

    const content = fs.readFileSync(dlq.getFilePath(), 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(3);

    const ids = lines.map((line) => JSON.parse(line).event.id);
    expect(ids).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('loads existing events from file on initialization', async () => {
    const event1 = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
    const event2 = { id: 'evt-2', contractId: 'C2', ledger: 2, topic: ['t2'], value: {} };

    await dlq.enqueue(event1, new Error('fail'));
    await dlq.enqueue(event2, new Error('fail'));

    // Create a new instance pointing to the same file
    const dlq2 = new FileDeadLetterQueue(dlq.getFilePath());

    const stored = dlq2.getAll();
    expect(stored).toHaveLength(2);
    expect(stored[0].event.id).toBe('evt-1');
    expect(stored[1].event.id).toBe('evt-2');
  });

  it('removes events from file', async () => {
    const event1 = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
    const event2 = { id: 'evt-2', contractId: 'C2', ledger: 2, topic: ['t2'], value: {} };

    await dlq.enqueue(event1, new Error('fail'));
    await dlq.enqueue(event2, new Error('fail'));

    const removed = await dlq.remove('evt-1');
    expect(removed).toBe(true);

    const stored = dlq.getAll();
    expect(stored).toHaveLength(1);
    expect(stored[0].event.id).toBe('evt-2');

    // Verify file is updated
    const content = fs.readFileSync(dlq.getFilePath(), 'utf-8');
    const lines = content.trim().split('\n').filter((l) => l);
    expect(lines).toHaveLength(1);
  });

  it('clears all events from file', async () => {
    const event1 = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
    const event2 = { id: 'evt-2', contractId: 'C2', ledger: 2, topic: ['t2'], value: {} };

    await dlq.enqueue(event1, new Error('fail'));
    await dlq.enqueue(event2, new Error('fail'));

    await dlq.clear();

    expect(dlq.getAll()).toHaveLength(0);

    // Verify file is truncated
    const content = fs.readFileSync(dlq.getFilePath(), 'utf-8');
    expect(content.trim()).toBe('');
  });

  it('handles concurrent enqueueing without data loss', async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      id: `evt-${i}`,
      contractId: `C${i}`,
      ledger: i,
      topic: [`topic-${i}`],
      value: {},
    }));

    // Enqueue all events concurrently
    await Promise.all(events.map((event) => dlq.enqueue(event, new Error('fail'))));

    const stored = dlq.getAll();
    expect(stored).toHaveLength(10);
    expect(new Set(stored.map((e) => e.event.id)).size).toBe(10);
  });

  it('provides file path for external replay/inspection', async () => {
    const filePath = dlq.getFilePath();

    expect(filePath).toBeTruthy();
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe('DeadLetterQueue integration with onEventFailure', () => {
  it('onEventFailure can delegate to InMemoryDeadLetterQueue', async () => {
    const dlq = new InMemoryDeadLetterQueue();

    const event = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
    const error = new Error('Event processing failed');

    // Simulate the onEventFailure callback
    const onEventFailure = async (event: MockRawContractEvent, error: unknown) => {
      await dlq.enqueue(event, error);
    };

    await onEventFailure(event, error);

    const stored = dlq.getAll();
    expect(stored).toHaveLength(1);
    expect(stored[0].event.id).toBe('evt-1');
  });

  it('onEventFailure can replay events from dead-letter queue', async () => {
    const tmpDir = path.join(__dirname, '..', '.test-dlq-replay');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const filePath = path.join(tmpDir, `dlq-replay-${Date.now()}.jsonl`);
    const dlq = new FileDeadLetterQueue(filePath);

    try {
      const event1 = { id: 'evt-1', contractId: 'C1', ledger: 1, topic: ['t1'], value: {} };
      const event2 = { id: 'evt-2', contractId: 'C2', ledger: 2, topic: ['t2'], value: {} };

      await dlq.enqueue(event1, new Error('fail'));
      await dlq.enqueue(event2, new Error('fail'));

      // Simulate replay: load all events and process
      const deadLetters = dlq.getAll();
      const replayed: string[] = [];

      for (const entry of deadLetters) {
        replayed.push(entry.event.id);
      }

      expect(replayed).toEqual(['evt-1', 'evt-2']);

      // Mark as processed (remove from DLQ)
      await dlq.remove('evt-1');
      expect(dlq.getAll()).toHaveLength(1);
    } finally {
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir);
        for (const file of files) {
          fs.unlinkSync(path.join(tmpDir, file));
        }
        fs.rmdirSync(tmpDir);
      }
    }
  });
});
