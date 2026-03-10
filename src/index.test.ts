/**
 * prisma-privacy-audit — unit tests
 *
 * These tests cover:
 *   - Extension shape and configuration defaults
 *   - Cross-user read detection logic (_collectCrossUserReads)
 *   - Audit log persistence (mock Prisma client)
 *   - purgeExpiredLogs utility
 *   - DSR method stubs
 *
 * Integration tests (actual $extends interception against a test database)
 * are in describe.todo blocks below. They require a real database connection.
 */

import { describe, expect, test, vi } from 'vitest'
import {
  withPrivacyAudit,
  purgeExpiredLogs,
  _collectCrossUserReads,
  type PrivacyAuditConfig,
  type AuditContext,
} from './index'

// Fixtures

const minimalConfig: PrivacyAuditConfig = {
  sensitiveModels: {
    CycleEntry: {
      fields: ['notes'],
      subjectField: 'userId',
    },
  },
}

const fullConfig: PrivacyAuditConfig = {
  sensitiveModels: {
    CycleEntry: {
      fields: ['notes'],
      subjectField: 'userId',
    },
    MoodEntry: {
      fields: ['notes'],
      subjectField: 'userId',
    },
    AgreementParty: {
      fields: ['expectations', 'privateNotes'],
      subjectField: 'userId',
    },
  },
  auditLog: {
    logSelfAccess: true,
    logWrites: true,
    samplingRate: 0.5,
    onFailure: 'store',
  },
  dsr: {
    models: {
      CycleEntry: { strategy: 'hard-delete' },
      MoodEntry: { strategy: 'hard-delete' },
      Agreement: { strategy: 'anonymize', fields: ['content'] },
      DataAccessLog: { strategy: 'preserve' },
    },
  },
}

describe('withPrivacyAudit', () => {
  test('returns an extension object with the correct name', () => {
    const ext = withPrivacyAudit(minimalConfig)
    expect(ext).toHaveProperty('name', 'prisma-privacy-audit')
  })

  test('extension has query and client properties', () => {
    const ext = withPrivacyAudit(minimalConfig)
    expect(ext).toHaveProperty('query')
    expect(ext).toHaveProperty('client')
  })

  test('client extension exposes $withAuditContext', () => {
    const ext = withPrivacyAudit(minimalConfig)
    expect(ext.client).toHaveProperty('$withAuditContext')
    expect(typeof ext.client.$withAuditContext).toBe('function')
  })

  test('$withAuditContext returns a new object, not the same reference', () => {
    const ext = withPrivacyAudit(minimalConfig)
    const fakeClient = {}
    const scoped = ext.client.$withAuditContext.call(fakeClient, { accessorId: 'user-a' })
    expect(scoped).not.toBe(fakeClient)
  })

  test('$withAuditContext scoped client inherits from the original via prototype chain', () => {
    const ext = withPrivacyAudit(minimalConfig)
    const fakeClient = { someMethod: () => 'ok' }
    const scoped = ext.client.$withAuditContext.call(fakeClient, { accessorId: 'user-a' }) as typeof fakeClient
    expect(scoped.someMethod).toBe(fakeClient.someMethod)
    expect(Object.getPrototypeOf(scoped)).toBe(fakeClient)
  })

  test('client extension exposes exportUserData', () => {
    const ext = withPrivacyAudit(minimalConfig)
    expect(ext.client).toHaveProperty('exportUserData')
    expect(typeof ext.client.exportUserData).toBe('function')
  })

  test('client extension exposes eraseUserData', () => {
    const ext = withPrivacyAudit(minimalConfig)
    expect(ext.client).toHaveProperty('eraseUserData')
    expect(typeof ext.client.eraseUserData).toBe('function')
  })

  test('accepts a full configuration without errors', () => {
    expect(() => withPrivacyAudit(fullConfig)).not.toThrow()
  })

  test('accepts multiple sensitive models', () => {
    const ext = withPrivacyAudit(fullConfig)
    expect(ext).toHaveProperty('name', 'prisma-privacy-audit')
  })
})

describe('_collectCrossUserReads', () => {
  const modelConfig = { fields: ['notes'], subjectField: 'userId' }
  const accessor: AuditContext = { accessorId: 'user-a', accessLevel: 'full' }

  test('returns empty array for null result', () => {
    const entries = _collectCrossUserReads(accessor, modelConfig, null, false)
    expect(entries).toHaveLength(0)
  })

  test('returns empty array for undefined result', () => {
    const entries = _collectCrossUserReads(accessor, modelConfig, undefined, false)
    expect(entries).toHaveLength(0)
  })

  test('detects cross-user read on a single record', () => {
    const record = { id: '1', userId: 'user-b', notes: 'enc:...' }
    const entries = _collectCrossUserReads(accessor, modelConfig, record, false)
    expect(entries).toHaveLength(1)
    expect(entries[0].subjectId).toBe('user-b')
  })

  test('detects cross-user reads across an array of records', () => {
    const records = [
      { id: '1', userId: 'user-b', notes: 'enc:...' },
      { id: '2', userId: 'user-c', notes: 'enc:...' },
    ]
    const entries = _collectCrossUserReads(accessor, modelConfig, records, false)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.subjectId)).toEqual(['user-b', 'user-c'])
  })

  test('does not log self-reads when logSelfAccess is false', () => {
    const ownRecord = { id: '1', userId: 'user-a', notes: 'enc:...' }
    const entries = _collectCrossUserReads(accessor, modelConfig, ownRecord, false)
    expect(entries).toHaveLength(0)
  })

  test('logs self-reads when logSelfAccess is true', () => {
    const ownRecord = { id: '1', userId: 'user-a', notes: 'enc:...' }
    const entries = _collectCrossUserReads(accessor, modelConfig, ownRecord, true)
    expect(entries).toHaveLength(1)
    expect(entries[0].subjectId).toBe('user-a')
  })

  test('skips records without the subjectField', () => {
    const record = { id: '1', notes: 'enc:...' } // no userId
    const entries = _collectCrossUserReads(accessor, modelConfig, record, false)
    expect(entries).toHaveLength(0)
  })

  test('skips records where subjectField is not a string', () => {
    const record = { id: '1', userId: 42, notes: 'enc:...' }
    const entries = _collectCrossUserReads(accessor, modelConfig, record, false)
    expect(entries).toHaveLength(0)
  })

  test('mixed array: logs cross-user reads, skips self-reads', () => {
    const records = [
      { id: '1', userId: 'user-a', notes: 'enc:...' }, // self — skip
      { id: '2', userId: 'user-b', notes: 'enc:...' }, // cross-user — log
      { id: '3', userId: 'user-c', notes: 'enc:...' }, // cross-user — log
    ]
    const entries = _collectCrossUserReads(accessor, modelConfig, records, false)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.subjectId)).toEqual(['user-b', 'user-c'])
  })

  test('uses the configured subjectField, not a hardcoded one', () => {
    const altModelConfig = { fields: ['content'], subjectField: 'ownerId' }
    const record = { id: '1', ownerId: 'user-b', content: 'enc:...' }
    const entries = _collectCrossUserReads(accessor, altModelConfig, record, false)
    expect(entries).toHaveLength(1)
    expect(entries[0].subjectId).toBe('user-b')
  })
})

describe('audit log persistence', () => {
  const ctx = { accessorId: 'user-a' }
  const record = { id: '1', userId: 'user-b', notes: 'sensitive' }

  function makeScopedClient(ext: ReturnType<typeof withPrivacyAudit>) {
    return ext.client.$withAuditContext.call({}, ctx)
  }

  test('calls prisma.privacyAuditLog.create on cross-user read', async () => {
    const mockCreate = vi.fn().mockResolvedValue({})
    const mockPrisma = { privacyAuditLog: { create: mockCreate } }

    const ext = withPrivacyAudit({ ...minimalConfig, prisma: mockPrisma })
    const scopedClient = makeScopedClient(ext)

    await ext.query.$allModels.$allOperations.call(scopedClient, {
      model: 'CycleEntry',
      operation: 'findUnique',
      args: {},
      query: async () => record,
    })

    await new Promise((r) => setTimeout(r, 0))

    expect(mockCreate).toHaveBeenCalledOnce()
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accessorId: 'user-a',
        subjectId: 'user-b',
        model: 'CycleEntry',
        action: 'read',
      }),
    })
  })

  test('does not call prisma.privacyAuditLog.create when prisma is not configured', async () => {
    const mockCreate = vi.fn()

    const ext = withPrivacyAudit(minimalConfig)
    const scopedClient = makeScopedClient(ext)

    await ext.query.$allModels.$allOperations.call(scopedClient, {
      model: 'CycleEntry',
      operation: 'findUnique',
      args: {},
      query: async () => record,
    })

    await new Promise((r) => setTimeout(r, 0))

    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('onFailure: silent swallows persistence errors', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('DB down'))
    const mockPrisma = { privacyAuditLog: { create: mockCreate } }

    const ext = withPrivacyAudit({
      ...minimalConfig,
      prisma: mockPrisma,
      auditLog: { onFailure: 'silent' },
    })
    const scopedClient = makeScopedClient(ext)

    await ext.query.$allModels.$allOperations.call(scopedClient, {
      model: 'CycleEntry',
      operation: 'findUnique',
      args: {},
      query: async () => record,
    })

    await new Promise((r) => setTimeout(r, 0))

    // main operation returned the result despite the persistence failure
    expect(mockCreate).toHaveBeenCalledOnce()
  })

  test('does not log when there is no audit context (plain prisma, no $withAuditContext)', async () => {
    const mockCreate = vi.fn().mockResolvedValue({})
    const mockPrisma = { privacyAuditLog: { create: mockCreate } }

    const ext = withPrivacyAudit({ ...minimalConfig, prisma: mockPrisma })

    // No $withAuditContext — this is the plain client case
    await ext.query.$allModels.$allOperations.call({}, {
      model: 'CycleEntry',
      operation: 'findUnique',
      args: {},
      query: async () => record,
    })

    await new Promise((r) => setTimeout(r, 0))

    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('does not log reads on models not in sensitiveModels', async () => {
    const mockCreate = vi.fn().mockResolvedValue({})
    const mockPrisma = { privacyAuditLog: { create: mockCreate } }

    const ext = withPrivacyAudit({ ...minimalConfig, prisma: mockPrisma })
    const scopedClient = makeScopedClient(ext)

    await ext.query.$allModels.$allOperations.call(scopedClient, {
      model: 'PublicModel', // not in sensitiveModels
      operation: 'findMany',
      args: {},
      query: async () => [record],
    })

    await new Promise((r) => setTimeout(r, 0))

    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('does not log write operations when logWrites is false (default)', async () => {
    const mockCreate = vi.fn().mockResolvedValue({})
    const mockPrisma = { privacyAuditLog: { create: mockCreate } }

    const ext = withPrivacyAudit({ ...minimalConfig, prisma: mockPrisma })
    const scopedClient = makeScopedClient(ext)

    await ext.query.$allModels.$allOperations.call(scopedClient, {
      model: 'CycleEntry',
      operation: 'create',
      args: { data: record },
      query: async () => record,
    })

    await new Promise((r) => setTimeout(r, 0))

    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('onFailure: throw surfaces persistence errors to the caller', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('DB down'))
    const mockPrisma = { privacyAuditLog: { create: mockCreate } }

    const ext = withPrivacyAudit({
      ...minimalConfig,
      prisma: mockPrisma,
      auditLog: { onFailure: 'throw' },
    })
    const scopedClient = makeScopedClient(ext)

    await expect(
      ext.query.$allModels.$allOperations.call(scopedClient, {
        model: 'CycleEntry',
        operation: 'findUnique',
        args: {},
        query: async () => record,
      }),
    ).rejects.toThrow('DB down')
  })
})

describe('exportUserData (stub)', () => {
  test('throws not yet implemented', async () => {
    const ext = withPrivacyAudit(minimalConfig)
    // Called as standalone to test the stub. In production: prisma.exportUserData({ ... })
    await expect(
      ext.client.exportUserData.call({}, { subjectId: 'user-a' }),
    ).rejects.toThrow('not yet implemented')
  })
})

describe('eraseUserData (stub)', () => {
  test('throws not yet implemented', async () => {
    const ext = withPrivacyAudit(minimalConfig)
    await expect(
      ext.client.eraseUserData.call({}, { subjectId: 'user-a' }),
    ).rejects.toThrow('not yet implemented')
  })
})

describe('purgeExpiredLogs', () => {
  test('calls deleteMany with a cutoff date and returns deleted count', async () => {
    const mockDeleteMany = vi.fn().mockResolvedValue({ count: 42 })
    const mockPrisma = { privacyAuditLog: { deleteMany: mockDeleteMany } }

    const result = await purgeExpiredLogs(mockPrisma, 90)

    expect(result).toEqual({ deleted: 42 })
    expect(mockDeleteMany).toHaveBeenCalledOnce()
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    })
  })

  test('cutoff date is approximately retentionDays ago', async () => {
    const mockDeleteMany = vi.fn().mockResolvedValue({ count: 0 })
    const mockPrisma = { privacyAuditLog: { deleteMany: mockDeleteMany } }

    const before = new Date()
    await purgeExpiredLogs(mockPrisma, 30)
    const after = new Date()

    const cutoff: Date = mockDeleteMany.mock.calls[0][0].where.createdAt.lt
    const expectedCutoff = new Date(before)
    expectedCutoff.setDate(expectedCutoff.getDate() - 30)

    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedCutoff.getTime() - 1000)
    expect(cutoff.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  test('returns { deleted: 0 } when prisma is null', async () => {
    const result = await purgeExpiredLogs(null)
    expect(result).toEqual({ deleted: 0 })
  })

  test('defaults to 90-day retention', async () => {
    const mockDeleteMany = vi.fn().mockResolvedValue({ count: 0 })
    const mockPrisma = { privacyAuditLog: { deleteMany: mockDeleteMany } }

    await purgeExpiredLogs(mockPrisma)

    const cutoff: Date = mockDeleteMany.mock.calls[0][0].where.createdAt.lt
    const ninetyDaysAgo = new Date()
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

    expect(Math.abs(cutoff.getTime() - ninetyDaysAgo.getTime())).toBeLessThan(1000)
  })
})

// Integration tests

describe.todo('$withAuditContext integration', () => {
  test.todo('cross-user read through auditedPrisma creates a DataAccessLog entry')
  test.todo('self-read through auditedPrisma does not create a log entry by default')
  test.todo('self-read is logged when logSelfAccess: true')
  test.todo('samplingRate: 0 prevents all log entries')
  test.todo('onFailure: store writes to PrivacyAuditDeadLetter on persist failure')
  test.todo('read through plain prisma (no context) does not log')
})

describe.todo('DSR Export (Article 15)', () => {
  test.todo('exports all records for a given subjectId across configured models')
  test.todo('encrypted fields are included in decrypted form')
  test.todo('result includes exportedAt timestamp and schemaVersion')
  test.todo('format: csv flattens nested structures')
})

describe.todo('DSR Erasure (Article 17)', () => {
  test.todo('hard-delete removes all records for subjectId')
  test.todo('anonymize nullifies configured fields without deleting the record')
  test.todo('preserve strategy leaves records untouched')
  test.todo('receipt includes receiptHash as SHA-256 of the payload')
  test.todo('receipt is consistent on retry (idempotent erasure)')
})
