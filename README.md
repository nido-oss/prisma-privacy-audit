# prisma-privacy-audit

> GDPR audit trail and Data Subject Request automation for Prisma ORM

Handles the compliance layer that Prisma doesn't: who accessed sensitive fields,
when, and at what permission level. Also automates GDPR data subject requests
(export and erasure).

Extracted from live code in Nido, where it protects health and relationship
data under GDPR Article 9 (special category data).

## API

```ts
import { PrismaClient } from '@prisma/client'
import { withPrivacyAudit } from 'prisma-privacy-audit'

const prisma = new PrismaClient().$extends(
  withPrivacyAudit({
    sensitiveModels: {
      CycleEntry: { fields: ['notes'], subjectField: 'userId' },
      MoodEntry:   { fields: ['notes'], subjectField: 'userId' },
      AgreementParty: {
        fields: ['expectations', 'privateNotes'],
        subjectField: 'userId',
      },
    },
    auditLog: {
      retention: 90,        // days before auto-purge
      onFailure: 'silent',  // 'silent' | 'store' | 'throw'
    },
    dsr: {
      models: {
        CycleEntry:    { strategy: 'hard-delete' },
        MoodEntry:     { strategy: 'hard-delete' },
        Agreement:     { strategy: 'anonymize', fields: ['content'] },
        DataAccessLog: { strategy: 'preserve' },
      },
    },
  })
)

// Cross-user reads are logged automatically via $withAuditContext
const auditedPrisma = prisma.$withAuditContext({
  accessorId: session.userId,
  accessLevel: 'phase_only',
})

const entry = await auditedPrisma.cycleEntry.findUnique({ where: { id } })
// → DataAccessLog entry created if accessorId !== entry.userId

// Article 15 — export all personal data for a user
const { data } = await prisma.exportUserData({ subjectId: userId })

// Article 17 — cascading erasure with tamper-evident receipt
const { receipt } = await prisma.eraseUserData({ subjectId: userId })
```

## Features

**Access audit logging**
A Prisma `$extends` extension that logs every read of configured sensitive fields:
`accessorId`, `subjectId`, `model`, `field`, `action`, `accessLevel`, `timestamp`.
Non-blocking: audit writes never delay a request. Configurable retention with auto-expiry.

**GDPR Data Subject Request automation**
Declarative handlers for Article 15 (export all personal data as JSON/CSV)
and Article 17 (cascading deletion per model, with a tamper-evident receipt).

**Granular sharing model**
When user A shares their data with user B at a given access level (e.g.
`phase_only` vs `full`), every cross-user read is logged with that level
as context.

## Relationship to prisma-field-encryption

| Library | Responsibility |
|---|---|
| [`prisma-field-encryption`](https://github.com/47ng/prisma-field-encryption) | Encrypts sensitive fields at rest |
| `prisma-privacy-audit` | Records who accessed them, enables GDPR rights |

If using both, apply encryption first:

```ts
const prisma = new PrismaClient()
  .$extends(withEncryption({ encryptionKey: process.env.KEY })) // 47ng — runs first
  .$extends(withPrivacyAudit({ ... }))                          // sees plaintext
```

## Roadmap

- [x] `$extends` architecture and API surface
- [x] Cross-user read detection (unit tested)
- [x] `purgeExpiredLogs` utility
- [ ] Audit log persistence (PrivacyAuditLog table)
- [ ] `$withAuditContext` (request-scoped client binding)
- [ ] DSR Export handler (Article 15)
- [ ] DSR Erasure handler (Article 17) with tamper-evident receipt
- [ ] Write logging
- [ ] Compatibility with `prisma-field-encryption`
- [ ] Independent security audit
- [ ] npm publication

## Requirements

- Prisma 5+
- TypeScript 5+
- Node.js 18+

## Contributing

Open questions and feedback in [RFC-001](docs/RFC-001-api-design.md).
Issues welcome on GitHub.

## License

MIT © [Karelys Denis](https://github.com/karelysdenis)
