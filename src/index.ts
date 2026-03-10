/**
 * prisma-privacy-audit
 *
 * GDPR audit trail and Data Subject Request automation for Prisma ORM.
 *
 * Provides:
 *   - Access audit logging via Prisma $extends
 *   - GDPR Article 15: structured personal data export
 *   - GDPR Article 17: cascading erasure with tamper-evident receipt
 *
 * See ARCHITECTURE.md for design decisions.
 * See docs/RFC-001-api-design.md for open API design questions.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Prisma } from '@prisma/client'

export interface SensitiveModelConfig {
  /** Fields to audit on this model. */
  fields: string[]
  /**
   * Name of the field that identifies the data owner (subject).
   * Used to detect cross-user reads: if accessorId !== record[subjectField],
   * the read is logged.
   */
  subjectField: string
}

export interface AuditLogConfig {
  /** Days before audit entries are eligible for purge. Default: 90. */
  retention?: number
  /** Log reads where accessor === subject (self-reads). Default: false. */
  logSelfAccess?: boolean
  /** Log create/update of sensitive fields. Default: false. */
  logWrites?: boolean
  /**
   * Fraction of reads to log (0.0–1.0). Default: 1.0.
   * Reduce in high-traffic environments where full logging is too expensive.
   */
  samplingRate?: number
  /**
   * What to do when an audit write fails.
   *   'silent' — swallow the error (default)
   *   'store'  — write to PrivacyAuditDeadLetter table for later retry
   *   'throw'  — surface the error to the caller
   */
  onFailure?: 'silent' | 'store' | 'throw'
}

export interface DSRModelConfig {
  /**
   * How to handle this model during erasure.
   *   'hard-delete' — physical deletion via deleteMany
   *   'anonymize'   — nullify personal fields, preserve record structure
   *   'preserve'    — do not delete (e.g., audit logs are legal records)
   */
  strategy: 'hard-delete' | 'anonymize' | 'preserve'
  /** Fields to nullify when strategy is 'anonymize'. */
  fields?: string[]
}

export interface PrivacyAuditConfig {
  /** Which models contain sensitive fields and who owns them. */
  sensitiveModels: Record<string, SensitiveModelConfig>
  /** Audit log options. */
  auditLog?: AuditLogConfig
  /** DSR erasure configuration. Required to use eraseUserData(). */
  dsr?: {
    models: Record<string, DSRModelConfig>
  }
}

export interface AuditContext {
  /** The authenticated user making the request. */
  accessorId: string
  /**
   * Sharing level granted by the data owner. Stored in the log entry.
   * e.g. 'phase_only', 'full', 'basic'
   */
  accessLevel?: string
}

// Internal: used to pass audit context through the $extends client prototype chain.
const AUDIT_CONTEXT = Symbol('prisma-privacy-audit:context')

interface LogEntry {
  accessorId: string
  subjectId: string
  model: string
  action: 'read' | 'write' | 'delete'
  accessLevel?: string
}

/**
 * Prisma $extends extension that adds access audit logging and GDPR DSR handling.
 *
 * Usage:
 *   const prisma = new PrismaClient().$extends(withPrivacyAudit({ ... }))
 *
 * Compose with prisma-field-encryption (47ng) by applying encryption first:
 *   const prisma = new PrismaClient()
 *     .$extends(withEncryption({ ... }))   // encryption runs first
 *     .$extends(withPrivacyAudit({ ... })) // audit layer sees plaintext
 */
export function withPrivacyAudit(config: PrivacyAuditConfig) {
  const logConfig: Required<AuditLogConfig> = {
    retention: config.auditLog?.retention ?? 90,
    logSelfAccess: config.auditLog?.logSelfAccess ?? false,
    logWrites: config.auditLog?.logWrites ?? false,
    samplingRate: config.auditLog?.samplingRate ?? 1.0,
    onFailure: config.auditLog?.onFailure ?? 'silent',
  }

  async function persistAuditEntry(_entry: LogEntry): Promise<void> {
    // TODO: (_auditPrisma as any).privacyAuditLog.create({ data: { ..._entry } })
  }

  // Non-blocking audit entry write.
  // Intentionally not awaited — the audit log must never block or fail
  // the request lifecycle. Failure is handled per logConfig.onFailure.
  function fireAndForgetLog(entry: LogEntry): void {
    persistAuditEntry(entry).catch((err: unknown) => {
      if (logConfig.onFailure === 'throw') throw err
      if (logConfig.onFailure === 'store') {
        // TODO: write to PrivacyAuditDeadLetter table for inspection and retry
      }
      // 'silent': swallow — intentional
    })
  }

  function detectAndLogCrossUserReads(
    ctx: AuditContext,
    model: string,
    modelConfig: SensitiveModelConfig,
    result: unknown,
  ): void {
    if (result == null) return

    const toLog = _collectCrossUserReads(ctx, modelConfig, result, logConfig.logSelfAccess)

    for (const entry of toLog) {
      if (logConfig.samplingRate < 1.0 && Math.random() > logConfig.samplingRate) continue

      fireAndForgetLog({
        accessorId: ctx.accessorId,
        subjectId: entry.subjectId,
        model,
        action: 'read',
        accessLevel: ctx.accessLevel,
      })
    }
  }

  // Return the extension config as a plain object.
  // PrismaClient.$extends() accepts both the plain object form and the
  // Prisma.defineExtension() wrapper — we use the plain form for testability.
  return {
    name: 'prisma-privacy-audit' as const,

    query: {
      $allModels: {
        // Uses `any` — Prisma's $allModels.$allOperations generics require it.
        // The public API surface (PrivacyAuditConfig, AuditContext, DSR methods) is fully typed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations(this: any, { model, operation, args, query }: any) {
          const modelConfig: SensitiveModelConfig | undefined =
            model != null ? config.sensitiveModels[model as string] : undefined

          // Execute the actual query first — audit logging is non-blocking
          // and must never delay or block the response.
          const result = await query(args)

          if (!modelConfig) return result

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx: AuditContext | undefined = (this as any)[AUDIT_CONTEXT]

          // Read operations: detect and log cross-user access
          const isRead = ['findUnique', 'findFirst', 'findMany', 'findUniqueOrThrow', 'findFirstOrThrow'].includes(operation as string)
          if (isRead && ctx) {
            detectAndLogCrossUserReads(ctx, model as string, modelConfig, result)
          }

          // Write operations: log creation/modification of sensitive fields
          const isWrite = ['create', 'update', 'upsert'].includes(operation as string)
          if (logConfig.logWrites && isWrite && ctx) {
            // TODO: logWriteAccess(ctx, model, modelConfig, operation, args)
          }

          return result
        },
      },
    },

    client: {
      /**
       * Returns a request-scoped client with the accessor identity bound.
       * Cross-user reads through this client are logged automatically.
       *
       *   const auditedPrisma = prisma.$withAuditContext({ accessorId: session.userId })
       *   const data = await auditedPrisma.cycleEntry.findMany({ ... })
       *
       * See RFC-001 for the AsyncLocalStorage alternative and tradeoffs.
       */
      $withAuditContext(
        this: object,
        ctx: AuditContext,
      ): object {
        return Object.assign(Object.create(this), { [AUDIT_CONTEXT]: ctx })
      },

      /**
       * GDPR Article 15 — Right of access.
       * Exports all personal data for a given subject across configured models.
       * See ARCHITECTURE.md §"DSR handler design" for the planned implementation.
       */
      async exportUserData(
        this: object,
        _options: { subjectId: string; format?: 'json' | 'csv' },
      ): Promise<ExportResult> {
        throw new Error('not yet implemented')
      },

      /**
       * GDPR Article 17 — Right to erasure.
       * Executes cascading deletion/anonymisation per DSR model strategy.
       * Returns a tamper-evident receipt with SHA-256 hash for non-repudiation.
       * See ARCHITECTURE.md §"DSR handler design" for the planned implementation.
       */
      async eraseUserData(
        this: object,
        _options: { subjectId: string },
      ): Promise<ErasureReceipt> {
        throw new Error('not yet implemented')
      },
    },
  }
}

/**
 * Detection logic separated from the write side-effect so it's testable
 * without a database.
 *
 * @internal exported for testing
 */
export function _collectCrossUserReads(
  ctx: AuditContext,
  modelConfig: SensitiveModelConfig,
  result: unknown,
  logSelfAccess: boolean,
): Array<{ subjectId: string }> {
  if (result == null) return []

  const records = Array.isArray(result) ? result : [result]
  const entries: Array<{ subjectId: string }> = []

  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue

    const subjectId = (record as Record<string, unknown>)[modelConfig.subjectField]
    if (typeof subjectId !== 'string') continue
    if (!logSelfAccess && subjectId === ctx.accessorId) continue

    entries.push({ subjectId })
  }

  return entries
}

export interface ErasureAction {
  model: string
  strategy: DSRModelConfig['strategy']
  count: number
}

export interface ErasureReceipt {
  erasedAt: string
  subjectId: string
  actions: ErasureAction[]
  /** SHA-256 hash for verifying the receipt hasn't been tampered with. */
  receiptHash: string
}

export interface ExportResult {
  exportedAt: string
  schemaVersion: string
  subject: { id: string }
  /** Per-model arrays of personal data records. Encrypted fields are included decrypted. */
  records: Record<string, unknown[]>
}

/**
 * Deletes PrivacyAuditLog entries older than retentionDays.
 *
 * Call periodically — on server startup, via cron, or a scheduled job.
 * Can be called independently of the extension.
 *
 * Example:
 *   purgeExpiredLogs(prisma, 90).then(({ deleted }) =>
 *     console.log(`Purged ${deleted} expired audit entries`)
 *   )
 */
export async function purgeExpiredLogs(
  _prisma: unknown,
  retentionDays: number = 90,
): Promise<{ deleted: number }> {
  void retentionDays
  // TODO: prisma.privacyAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } })
  return { deleted: 0 }
}
