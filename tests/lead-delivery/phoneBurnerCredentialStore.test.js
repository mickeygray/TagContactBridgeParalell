"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { UserAccount } = require("../../packages/shared-models/src");
const userAccountRepository = require("../../packages/shared-repositories/src/userAccountRepository");
const {
  createPhoneBurnerDurableCredentialStore,
} = require("../../packages/shared-integrations/src/phoneBurnerClient");

function createFakeCrypto() {
  const values = new Map();
  let sequence = 0;
  return {
    encrypt(value) {
      sequence += 1;
      const ciphertext = `ciphertext-${sequence}`;
      values.set(ciphertext, String(value));
      return ciphertext;
    },
    decrypt(ciphertext) {
      return values.get(ciphertext) || null;
    },
  };
}

function createCredentialRepositoryHarness(initialRecord = {}) {
  let record = {
    accountId: "service-account-test",
    provider: "phoneburner",
    accessTokenEnc: null,
    refreshTokenEnc: null,
    tokenType: null,
    accessTokenExpiresAt: null,
    revision: 0,
    migratedAt: null,
    refreshedAt: null,
    ...initialRecord,
  };
  const writes = [];
  return {
    credentialRepository: {
      async readServiceProviderCredentialPair() {
        return record ? { ...record } : null;
      },
      async writeServiceProviderCredentialPair(input) {
        writes.push({ ...input });
        if (!record || input.expectedRevision !== record.revision) return null;
        record = {
          ...record,
          accessTokenEnc: input.accessTokenEnc,
          refreshTokenEnc: input.refreshTokenEnc,
          tokenType: input.tokenType,
          accessTokenExpiresAt: input.accessTokenExpiresAt,
          revision: record.revision + 1,
          migratedAt: input.migratedAt || record.migratedAt,
          refreshedAt: input.refreshedAt,
        };
        return {
          accountId: record.accountId,
          provider: record.provider,
          tokenType: record.tokenType,
          accessTokenExpiresAt: record.accessTokenExpiresAt,
          revision: record.revision,
          migratedAt: record.migratedAt,
          refreshedAt: record.refreshedAt,
        };
      },
    },
    getRecord() {
      return record ? { ...record } : null;
    },
    writes,
  };
}

function createStore({ env, harness, crypto, now }) {
  return createPhoneBurnerDurableCredentialStore({
    env,
    serviceEmail: "service@example.test",
    credentialRepository: harness.credentialRepository,
    encrypt: crypto.encrypt,
    decrypt: crypto.decrypt,
    now,
  });
}

test("durable PhoneBurner store bootstraps once, then Mongo owns both tokens across restart", async () => {
  const env = {
    PB_HOT_SEAT_TOKEN: "bootstrap-access-test",
    PB_REFRESH_TOKEN: "bootstrap-refresh-test",
    PB_CLIENT_ID: "client-id-test",
    PB_CLIENT_SECRET: "client-secret-test",
  };
  const originalEnv = { ...env };
  const harness = createCredentialRepositoryHarness();
  const crypto = createFakeCrypto();
  const at = new Date("2026-07-10T20:00:00.000Z");
  const firstStore = createStore({ env, harness, crypto, now: () => at });

  assert.deepEqual(await firstStore.read(), {
    accessToken: "bootstrap-access-test",
    refreshToken: "bootstrap-refresh-test",
    clientId: "client-id-test",
    clientSecret: "client-secret-test",
  });
  assert.deepEqual(env, originalEnv);
  assert.equal(harness.writes.length, 1);
  assert.notEqual(harness.writes[0].accessTokenEnc, env.PB_HOT_SEAT_TOKEN);
  assert.notEqual(harness.writes[0].refreshTokenEnc, env.PB_REFRESH_TOKEN);
  assert.equal(harness.writes[0].expectedRevision, 0);
  assert.equal(harness.getRecord().revision, 1);

  env.PB_HOT_SEAT_TOKEN = "ignored-access-test";
  env.PB_REFRESH_TOKEN = "ignored-refresh-test";
  const restartedStore = createStore({ env, harness, crypto, now: () => at });
  const afterRestart = await restartedStore.read();
  assert.equal(afterRestart.accessToken, "bootstrap-access-test");
  assert.equal(afterRestart.refreshToken, "bootstrap-refresh-test");
  assert.equal(harness.writes.length, 1);

  await restartedStore.writeTokens({
    accessToken: "rotated-access-test",
    refreshToken: "rotated-refresh-test",
    tokenType: "bearer",
    expiresIn: 120,
  });
  assert.equal(harness.writes.length, 2);
  assert.equal(harness.writes[1].expectedRevision, 1);
  assert.ok(harness.writes[1].accessTokenEnc);
  assert.ok(harness.writes[1].refreshTokenEnc);
  assert.equal(harness.writes[1].accessTokenExpiresAt.toISOString(), "2026-07-10T20:02:00.000Z");
  assert.equal(env.PB_HOT_SEAT_TOKEN, "ignored-access-test");
  assert.equal(env.PB_REFRESH_TOKEN, "ignored-refresh-test");

  const secondRestart = createStore({ env, harness, crypto, now: () => at });
  const rotated = await secondRestart.read();
  assert.equal(rotated.accessToken, "rotated-access-test");
  assert.equal(rotated.refreshToken, "rotated-refresh-test");
});

test("concurrent revision-zero bootstraps converge on the one Mongo winner", async () => {
  const harness = createCredentialRepositoryHarness();
  const crypto = createFakeCrypto();
  const at = new Date("2026-07-10T20:00:00.000Z");
  const firstStore = createStore({
    env: {
      PB_HOT_SEAT_TOKEN: "first-access-test",
      PB_REFRESH_TOKEN: "first-refresh-test",
    },
    harness,
    crypto,
    now: () => at,
  });
  const secondStore = createStore({
    env: {
      PB_HOT_SEAT_TOKEN: "second-access-test",
      PB_REFRESH_TOKEN: "second-refresh-test",
    },
    harness,
    crypto,
    now: () => at,
  });

  const [firstRead, secondRead] = await Promise.all([firstStore.read(), secondStore.read()]);
  assert.equal(harness.writes.length, 2);
  assert.equal(harness.getRecord().revision, 1);
  assert.equal(firstRead.accessToken, secondRead.accessToken);
  assert.equal(firstRead.refreshToken, secondRead.refreshToken);
  assert.ok(["first-access-test", "second-access-test"].includes(firstRead.accessToken));
});

test("durable PhoneBurner store never falls back over a partial Mongo pair", async () => {
  const crypto = createFakeCrypto();
  const accessTokenEnc = crypto.encrypt("stored-access-test");
  const harness = createCredentialRepositoryHarness({
    accessTokenEnc,
    refreshTokenEnc: null,
    revision: 1,
  });
  const store = createStore({
    env: {
      PB_HOT_SEAT_TOKEN: "fallback-access-test",
      PB_REFRESH_TOKEN: "fallback-refresh-test",
    },
    harness,
    crypto,
    now: () => new Date("2026-07-10T20:00:00.000Z"),
  });

  await assert.rejects(store.read(), /stored credential pair is incomplete/);
  assert.equal(harness.writes.length, 0);
});

test("durable PhoneBurner store refuses a partial refresh before any persistence call", async () => {
  const crypto = createFakeCrypto();
  const harness = createCredentialRepositoryHarness({
    accessTokenEnc: crypto.encrypt("stored-access-test"),
    refreshTokenEnc: crypto.encrypt("stored-refresh-test"),
    revision: 2,
  });
  const store = createStore({
    env: {},
    harness,
    crypto,
    now: () => new Date("2026-07-10T20:00:00.000Z"),
  });

  await assert.rejects(
    store.writeTokens({ accessToken: "rotated-access-test" }),
    /refreshToken is required/,
  );
  assert.equal(harness.writes.length, 0);
});

test("UserAccount hides provider tokens and repository replaces the pair atomically", async () => {
  const accessPath = UserAccount.schema.path("providerCredentials.phoneBurner.accessTokenEnc");
  const refreshPath = UserAccount.schema.path("providerCredentials.phoneBurner.refreshTokenEnc");
  assert.equal(accessPath.options.select, false);
  assert.equal(refreshPath.options.select, false);

  const originals = {
    findById: UserAccount.findById,
    findOne: UserAccount.findOne,
    findOneAndUpdate: UserAccount.findOneAndUpdate,
  };
  let readFilter = null;
  let readSelection = null;
  let writeFilter = null;
  let writeUpdate = null;
  let writeOptions = null;
  let writeSelection = null;
  try {
    UserAccount.findById = () => ({
      async lean() {
        return {
          _id: "public-account-test",
          email: "service@example.test",
          name: "Service",
          role: "service",
          providerCredentials: {
            phoneBurner: {
              accessTokenEnc: "ciphertext-access-test",
              refreshTokenEnc: "ciphertext-refresh-test",
            },
          },
        };
      },
    });
    const publicAccount = await userAccountRepository.findUserAccountById("public-account-test");
    assert.equal(Object.hasOwn(publicAccount, "providerCredentials"), false);

    UserAccount.findOne = (filter) => {
      readFilter = filter;
      return {
        select(selection) {
          readSelection = selection;
          return this;
        },
        async lean() {
          return {
            _id: "service-account-test",
            providerCredentials: {
              phoneBurner: {
                accessTokenEnc: "ciphertext-access-test",
                refreshTokenEnc: "ciphertext-refresh-test",
                tokenType: "bearer",
                revision: 4,
              },
            },
          };
        },
      };
    };
    const privateRecord = await userAccountRepository.readServiceProviderCredentialPair({
      serviceEmail: " SERVICE@EXAMPLE.TEST ",
    });
    assert.deepEqual(readFilter, { email: "service@example.test", role: "service" });
    assert.match(readSelection, /\+providerCredentials\.phoneBurner\.accessTokenEnc/);
    assert.match(readSelection, /\+providerCredentials\.phoneBurner\.refreshTokenEnc/);
    assert.equal(privateRecord.accessTokenEnc, "ciphertext-access-test");
    assert.equal(privateRecord.refreshTokenEnc, "ciphertext-refresh-test");

    UserAccount.findOneAndUpdate = (filter, update, options) => {
      writeFilter = filter;
      writeUpdate = update;
      writeOptions = options;
      return {
        select(selection) {
          writeSelection = selection;
          return this;
        },
        async lean() {
          return {
            _id: "service-account-test",
            providerCredentials: {
              phoneBurner: {
                accessTokenEnc: "should-not-escape-test",
                refreshTokenEnc: "should-not-escape-test",
                tokenType: "bearer",
                revision: 1,
              },
            },
          };
        },
      };
    };
    const written = await userAccountRepository.writeServiceProviderCredentialPair({
      serviceEmail: "service@example.test",
      accessTokenEnc: "ciphertext-access-next-test",
      refreshTokenEnc: "ciphertext-refresh-next-test",
      tokenType: "bearer",
      expectedRevision: 0,
      migratedAt: new Date("2026-07-10T20:00:00.000Z"),
      refreshedAt: new Date("2026-07-10T20:00:00.000Z"),
    });
    assert.deepEqual(writeFilter, {
      email: "service@example.test",
      role: "service",
      $or: [
        { "providerCredentials.phoneBurner.revision": 0 },
        { "providerCredentials.phoneBurner.revision": { $exists: false } },
      ],
    });
    assert.equal(
      writeUpdate.$set["providerCredentials.phoneBurner.accessTokenEnc"],
      "ciphertext-access-next-test",
    );
    assert.equal(
      writeUpdate.$set["providerCredentials.phoneBurner.refreshTokenEnc"],
      "ciphertext-refresh-next-test",
    );
    assert.deepEqual(writeUpdate.$inc, { "providerCredentials.phoneBurner.revision": 1 });
    assert.deepEqual(writeOptions, { new: true, runValidators: true });
    assert.doesNotMatch(writeSelection, /accessTokenEnc|refreshTokenEnc/);
    assert.equal(Object.hasOwn(written, "accessTokenEnc"), false);
    assert.equal(Object.hasOwn(written, "refreshTokenEnc"), false);
  } finally {
    UserAccount.findById = originals.findById;
    UserAccount.findOne = originals.findOne;
    UserAccount.findOneAndUpdate = originals.findOneAndUpdate;
  }
});
