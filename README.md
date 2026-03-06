# prisma-privacy-audit

> GDPR audit trail and Data Subject Request automation for Prisma ORM

**Status: pre-development.** API design and implementation in progress.

Handles the compliance layer that Prisma doesn't: who accessed sensitive fields,
when, and at what permission level. Includes automated handling for GDPR
data subject requests (export and erasure).

## Planned API

```ts
import { PrismaClient } from '@prisma/client'
import { withPrivacyAudit } from 'prisma-privacy-audit'

const prisma = new PrismaClient().$extends(
  withPrivacyAudit({
    sensitiveFields: {
      CycleEntry: ['notes'],
      MoodEntry: ['notes'],
      AgreementParty: ['expectations', 'privateNotes'],
    },
    retention: { days: 90 },
  })
)

// Reads and writes are logged automatically
const entry = await prisma.cycleEntry.findUnique({
  where: { id },
  $audit: { accessorId: session.userId, accessLevel: 'phase_only' },
})

// Article 15 — export all personal data for a user
const data = await exportUserData(prisma, { subjectId: userId })

// Article 17 — cascading erasure with tamper-evident receipt
const receipt = await eraseUserData(prisma, { subjectId: userId })
```

## Features

**Access audit logging**
A Prisma `$extends` extension that logs every read and write of designated
sensitive fields: `accessorId`, `subjectId`, `model`, `field`, `action`,
`accessLevel`, `timestamp`. Non-blocking (fire-and-forget). Configurable
retention with automatic expiry.

**GDPR Data Subject Request automation**
Declarative handlers for Article 15 (export all personal data as JSON/CSV)
and Article 17 (cascading deletion per model, with a tamper-evident receipt).

**Granular sharing model**
When user A shares their data with user B at a given access level (e.g.
`phase_only` vs `full`), every cross-user read is logged with that level
as context, not just the fact of access.

## Complements, not replaces

| Library | Responsibility |
|---|---|
| [`prisma-field-encryption`](https://github.com/47ng/prisma-field-encryption) | Encrypts sensitive fields at rest |
| `prisma-privacy-audit` | Records who accessed them · enables GDPR rights |

## Roadmap

- [ ] Prisma `$extends` architecture (replaces deprecated `$use` middleware)
- [ ] Audit log engine (read/write logging, async buffer, configurable retention)
- [ ] DSR Export handler (Article 15)
- [ ] DSR Erasure handler (Article 17)
- [ ] Granular sharing model and access level integration
- [ ] Compatibility with `prisma-field-encryption`
- [ ] Independent security audit
- [ ] npm publication

## Requirements

- Prisma 5+
- TypeScript
- Node.js 18+

## Contributing

RFC process for API design will open on this repository.
Issues and discussion welcome.

## License

MIT © [Karelys Denis](https://github.com/karelysdenis)
