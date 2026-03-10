# RFC-001: Public API Design

**Status:** open for comment ([discussion thread](https://github.com/orgs/nido-oss/discussions/1))
**Author:** Karelys Denis ([@karelysdenis](https://github.com/karelysdenis))
**Created:** March 2026
**Related:** [ARCHITECTURE.md](../ARCHITECTURE.md)

---

## Summary

I've been building Nido, a platform that handles menstrual health data,
mood tracking and relationship agreements for the past year. When I had to
implement GDPR compliance (audit logging, data export, erasure), I couldn't
find anything in the Prisma ecosystem that covered it. I wrote it from scratch,
embedded in Nido's codebase.

This library is the extraction of that code into something reusable. Before I
start pulling it out and designing the public API, I want to get the interface
right. These are the questions I'm uncertain about.

## Proposed public API

### 1. Extension configuration

```typescript
import { PrismaClient } from '@prisma/client'
import { withPrivacyAudit } from 'prisma-privacy-audit'

const prisma = new PrismaClient().$extends(
  withPrivacyAudit({
    sensitiveModels: {
      CycleEntry: {
        fields: ['notes'],
        subjectField: 'userId',
      },
      MoodEntry: {
        fields: ['notes'],
        subjectField: 'userId',
      },
    },
    auditLog: {
      retention: 90,
      onFailure: 'silent',
    },
    dsr: {
      models: {
        CycleEntry:  { strategy: 'hard-delete' },
        MoodEntry:   { strategy: 'hard-delete' },
        Agreement:   { strategy: 'anonymize', fields: ['content'] },
      },
    },
  })
)
```

### 2. Logging cross-user reads

```typescript
// Proposed: $withAuditContext — scoped client per request
const auditedPrisma = prisma.$withAuditContext({
  accessorId: session.userId,
  accessLevel: 'phase_only',
})

const entry = await auditedPrisma.cycleEntry.findUnique({ where: { id } })
// → audit log entry created automatically if accessorId !== entry.userId
```

### 3. DSR Export (Article 15)

```typescript
const { data } = await prisma.exportUserData({
  subjectId: userId,
  format: 'json',
})
```

### 4. DSR Erasure (Article 17)

```typescript
const { receipt } = await prisma.eraseUserData({
  subjectId: userId,
})

// receipt.receiptHash — tamper-evident proof of erasure
// receipt.actions — per-model deletion records
```

## Open questions

### 1. How to pass accessor context into the extension?

This is the hard part. The `$extends` interceptor runs at the ORM layer — it
can see query arguments and results, but has no idea who is making the request.
I've narrowed it down to three approaches:

**Option A: `$withAuditContext`**

```typescript
const auditedPrisma = prisma.$withAuditContext({ accessorId: session.userId })
const data = await auditedPrisma.cycleEntry.findMany({ ... })
```

**Option A** is what I have in Nido today, without the library wrapping. You
create a context-bound client at the top of the handler and use it for all
queries in that scope. What I like: it's visible in code review, you can see
exactly which reads are being audited. What worries me: if someone uses `prisma`
instead of `auditedPrisma` by mistake, there's no error, the read just doesn't
get logged. It's a softer version of the same problem I'm trying to solve.

**Option B: AsyncLocalStorage.** You set the context once in HTTP middleware
and every read in that scope gets logged automatically, without touching route
code. That's appealing if you're adding this to an existing app with 40 routes.
The problem is Node.js only (no edge runtimes), tests get complicated, and I'm
uneasy with implicit behavior in an audit library. If something goes wrong,
"it logs automatically" is harder to debug than "I explicitly created an audited
client here".

```typescript
// In HTTP middleware (runs once per request):
auditContext.run({ accessorId: session.userId }, async () => {
  await next()
})

// Inside $extends, the accessor is read from AsyncLocalStorage automatically.
// No code changes needed in route handlers.
const data = await prisma.cycleEntry.findMany({ ... })
```

**Option C: inline `$audit` per query.** I'm including it for completeness. Extending Prisma types to add `$audit`
inline on each query requires significant type complexity, and it's essentially
the same problem as the manual `logDataAccess()` calls I have now: verbose and
easy to forget.

```typescript
const data = await prisma.cycleEntry.findMany({
  where: { userId: targetId },
  $audit: { accessorId: session.userId, accessLevel: 'phase_only' },
})
```

In Nido today I have manual `logDataAccess()` calls after each cross-user read,
which is basically Option C without the Prisma type extension. It works, but I've
already missed logging a route once during a refactor. That's the problem I want
the library to solve.

My current preference is Option A, with Option B available as an opt-in.
Option A is explicit enough that you can reason about it in tests and code
review; Option B is the right call if you're adding this to an existing app
with dozens of routes and don't want to thread the scoped client everywhere.
But I'm not sure — especially whether `$withAuditContext` creates friction
that makes developers skip it.

### 2. Should writes be logged?

Right now in Nido I only log reads of sensitive fields specifically, when
user A reads user B's data. The proposed `logWrites` flag defaults to `false`.

The case for logging writes: GDPR Article 30 covers all processing activities,
not just access. For health data, knowing *when* something was written can
matter. The case against: write logging roughly doubles the volume of audit
entries, and most GDPR audit questions I've encountered in practice are about
"who read this data" rather than "who created it". The database transaction log
already captures the latter.

I'd like to know if your use case requires write logging, or if read-only
logging would cover your GDPR obligations.

### 3. DSR Erasure: transaction or sequential?

When `eraseUserData` runs, it has to delete or anonymize records across several
models. Two approaches:

**Option A: Single Prisma transaction**
```typescript
await prisma.$transaction(async (tx) => {
  await tx.cycleEntry.deleteMany({ where: { userId } })
  await tx.moodEntry.deleteMany({ where: { userId } })
  // ... all models
})
```

**Option A** is cleaner to reason about: either it worked or it didn't. But I've had transactions fail in Nido for fairly
minor operations, and `preserve` models have to stay outside the transaction
anyway. The receipt can only be written after the commit, which means if the
receipt write fails you have no record that the deletion succeeded.

**Option B: Sequential operations with receipt-as-progress-log**
```typescript
const actions = []
actions.push(await deleteModel(prisma, 'CycleEntry', userId))
actions.push(await deleteModel(prisma, 'MoodEntry', userId))
// ... each model independently logged as it completes
```

**Option B** deletes and logs each model independently, so if it fails
mid-way the receipt shows exactly what happened and what didn't. That makes
retrying easier. What it gives up is true atomicity: a partial deletion can
be visible.

For the volumes I'm dealing with (hundreds, at most thousands of records per
user) both work fine technically. The real question is which failure you'd rather
explain to the person who requested erasure: "nothing was deleted, please try
again" or "your cycle data was deleted but the process stopped halfway".

## Out of scope for v1.0

- Encryption at rest (use [`prisma-field-encryption`](https://github.com/47ng/prisma-field-encryption) for that)
- SIEM integrations (Datadog, Splunk, etc.)
- Audit log UI
- Other ORMs (Drizzle, TypeORM), possible v2 if there's interest
- Edge runtime support (Vercel Edge, Cloudflare Workers)

## Discussion

Leaving this open through **May 2026**. Most interested in:

- Whether Question 1 (accessor context) matters in practice for how you'd
  adopt this — would `$withAuditContext` be a dealbreaker?
- Anyone building on Prisma who's had to implement GDPR compliance themselves
  and has patterns that worked or didn't
- Prior art you know of
