import { erase, ERASE_SQL, planErase, type EraseDb } from './erase.js';

function harness(installs: string[] = ['install-1']) {
  const calls: string[] = [];
  const db: EraseDb = {
    installsForIdentity: async (id) => {
      calls.push(`lookup:${id}`);
      return installs;
    },
    deleteEvents: async (ids) => {
      calls.push(`events:${ids.join(',')}`);
      return ids.length * 10;
    },
    deleteCounters: async (ids) => {
      calls.push(`counters:${ids.join(',')}`);
      return ids.length;
    },
    deleteOrphans: async (id) => {
      calls.push(`orphans:${id}`);
      return 0;
    },
  };
  return { db, calls };
}

describe('it cannot run by accident', () => {
  // forbidden-pattern #15: a destructive function with a working default is one
  // careless call away from running, and the careless call is usually a test.
  it('refuses without confirmation, and touches nothing', async () => {
    const h = harness();
    const result = await erase({ identityId: 'auth0|abc' }, h.db);
    expect(result.ok).toBe(false);
    expect(h.calls).toEqual([]);
  });

  // A BOOLEAN IS WHAT A TEST PASSES BY ACCIDENT. The confirmation has to name
  // the same subject, so an erase cannot be triggered by a truthy variable and
  // cannot erase a different subject from the one somebody typed.
  it('refuses a confirmation that names somebody else', async () => {
    const h = harness();
    const result = await erase(
      { identityId: 'auth0|abc', confirmSubject: 'auth0|someone-else' },
      h.db,
    );
    expect(result.ok).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('refuses when nothing was named', async () => {
    expect(planErase({ confirmSubject: '' }).ok).toBe(false);
    expect(planErase({ identityId: '', confirmSubject: '' }).ok).toBe(false);
  });

  // Two subjects is an ambiguous instruction, and the wrong one to guess at.
  it('refuses a request naming both a person and an installation', async () => {
    const h = harness();
    const result = await erase(
      { identityId: 'a', installId: 'b', confirmSubject: 'a' },
      h.db,
    );
    expect(result.ok).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

describe('erasing a person', () => {
  // THE JOIN RUNS BACKWARDS. Events carry an identity only AFTER a sign-in, and
  // the anonymous history before it belongs to the same person — so deleting
  // "rows where identityId = X" leaves behind exactly what the join exists to
  // claim for them.
  it('finds every installation the identity ever appeared on', async () => {
    const h = harness(['install-1', 'install-2']);
    const result = await erase(
      { identityId: 'auth0|abc', confirmSubject: 'auth0|abc' },
      h.db,
    );
    expect(result.ok).toBe(true);
    expect(h.calls[0]).toBe('lookup:auth0|abc');
    expect(h.calls).toContain('events:install-1,install-2');
  });

  it('deletes the counters as well as the events', async () => {
    const h = harness();
    await erase({ identityId: 'auth0|abc', confirmSubject: 'auth0|abc' }, h.db);
    expect(h.calls).toContain('counters:install-1');
  });

  // "Should not exist" is not "does not exist", and a row this misses is a row
  // that survives a deletion somebody was told had happened.
  it('sweeps rows carrying the identity but no installation', async () => {
    const h = harness();
    await erase({ identityId: 'auth0|abc', confirmSubject: 'auth0|abc' }, h.db);
    expect(h.calls).toContain('orphans:auth0|abc');
  });

  it('reports what it actually removed', async () => {
    const h = harness(['i1', 'i2']);
    const result = await erase(
      { identityId: 'auth0|abc', confirmSubject: 'auth0|abc' },
      h.db,
    );
    if (!result.ok) throw new Error('expected success');
    expect(result.report).toEqual({
      subject: 'auth0|abc',
      installationsTouched: 2,
      eventsDeleted: 20,
      countersDeleted: 2,
    });
  });

  it('succeeds harmlessly when a person has no data at all', async () => {
    const h = harness([]);
    const result = await erase(
      { identityId: 'auth0|nobody', confirmSubject: 'auth0|nobody' },
      h.db,
    );
    if (!result.ok) throw new Error('expected success');
    expect(result.report.installationsTouched).toBe(0);
    expect(h.calls).not.toContain('events:');
  });
});

describe('erasing one installation', () => {
  // For somebody who never signed in, the installation IS the subject — there
  // is no identity to look up, and looking one up would be a query for nothing.
  it('deletes it directly without an identity lookup', async () => {
    const h = harness();
    const result = await erase(
      { installId: 'install-9', confirmSubject: 'install-9' },
      h.db,
    );
    expect(result.ok).toBe(true);
    expect(h.calls).not.toContain('lookup:install-9');
    expect(h.calls).toContain('events:install-9');
    expect(h.calls).toContain('counters:install-9');
  });
});

describe('the statements', () => {
  it('cover both tables and the orphan case', () => {
    expect(ERASE_SQL.eventsForInstalls).toContain('delete from events');
    expect(ERASE_SQL.countersForInstalls).toContain('delete from ingest_counters');
    expect(ERASE_SQL.orphansForIdentity).toContain('delete from events');
  });

  // A delete with no where clause is the one that empties the table.
  it('are all scoped — none of them deletes unconditionally', () => {
    for (const [name, sql] of Object.entries(ERASE_SQL)) {
      if (sql.startsWith('delete')) {
        expect(`${name}: ${sql}`).toContain('where');
      }
    }
  });

  it('parameterise every value rather than interpolating it', () => {
    for (const sql of Object.values(ERASE_SQL)) {
      expect(sql).toMatch(/\$\d/);
      expect(sql).not.toContain('${');
    }
  });
});
