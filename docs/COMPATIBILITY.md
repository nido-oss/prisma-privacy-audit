# Compatibility

## `prisma-field-encryption` (47ng)

These two libraries are meant to be used together: encryption protects fields at rest,
this library records who accessed them. But the `$extends` ordering matters and getting
it wrong is silent.

### Ordering

Encryption goes first (innermost), audit goes last (outermost):

```typescript
const prisma = new PrismaClient()
  .$extends(fieldEncryptionExtension({ ... })) // runs first — decrypts reads, encrypts writes
  .$extends(withPrivacyAudit({ ... }))         // runs after — sees plaintext
```

On a read, the innermost extension processes the database result first. So with this
ordering: DB returns ciphertext → encryption decrypts → audit sees plaintext → logs it.

If you flip the order, the audit layer receives ciphertext from the database and logs
it as the field value. No error is thrown. The log looks valid and is wrong.

### With Prisma Accelerate

Haven't integration-tested this yet, but based on how both extensions behave,
Accelerate should go between the two:

```typescript
const prisma = new PrismaClient()
  .$extends(fieldEncryptionExtension({ ... }))
  .$extends(withAccelerate())
  .$extends(withPrivacyAudit({ ... }))
```

Tracking this in the open issue with the 47ng maintainer.

### Known issues in `prisma-field-encryption`

- [#143](https://github.com/47ng/prisma-field-encryption/issues/143): Prisma 6.16.0
  broke the DMMF shape (`documentation` field missing). `fieldEncryptionExtension()`
  fails to initialize. Open since September 2025.

- [#142](https://github.com/47ng/prisma-field-encryption/issues/142): Same
  initialization failure with the new `prisma-client` generator. Open since April 2025.

- [#92](https://github.com/47ng/prisma-field-encryption/issues/92): Decryption wasn't
  working for some users with `$extends`. Most cases traced back to wrong extension
  ordering. No fix was landed, just workarounds in the comments.

### Smoke test

Before relying on the combination in production, verify it manually:

```typescript
const auditedPrisma = prisma.$withAuditContext({ accessorId: 'user-a' })
const record = await auditedPrisma.sensitiveModel.findUnique({ where: { id } })

// If this fails, the audit layer is seeing ciphertext
assert(!record.sensitiveField.startsWith('v1.aesgcm256.'))
```

### DSR Export

When `exportUserData` runs, encrypted fields need to come back decrypted. GDPR
requires giving users readable copies of their data. This only works if the ordering
above is respected, since the DSR handler reads through the same extension stack.
