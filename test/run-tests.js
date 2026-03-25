const crypto = require("crypto");
const assert = require("node:assert/strict");
const { Blockchain } = require("../src/blockchain");

function createWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    publicKey: publicKeyPem,
    privateKey: privateKeyPem,
    address: Blockchain.deriveAddressFromPublicKey(publicKeyPem),
  };
}

function signTransaction(tx, privateKey) {
  const payload = Blockchain.buildTransactionPayload(tx);
  return crypto.sign(null, Buffer.from(payload), privateKey).toString("base64");
}

function run(name, fn) {
  try {
    fn();
    // eslint-disable-next-line no-console
    console.log(`PASS ${name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

run("accepts valid signed transaction", () => {
  const chain = new Blockchain({ difficulty: 1, miningReward: 50 });
  const alice = createWallet();
  const bob = createWallet();

  chain.minePendingTransactions(alice.address);

  const tx = {
    fromAddress: alice.address,
    toAddress: bob.address,
    amount: 20,
    timestamp: new Date().toISOString(),
    publicKey: alice.publicKey,
  };
  tx.signature = signTransaction(tx, alice.privateKey);

  chain.addTransaction(tx);
  assert.equal(chain.pendingTransactions.length, 1);
});

run("rejects mismatched address and key", () => {
  const chain = new Blockchain({ difficulty: 1, miningReward: 50 });
  const alice = createWallet();
  const bob = createWallet();

  chain.minePendingTransactions(alice.address);

  const tx = {
    fromAddress: alice.address,
    toAddress: bob.address,
    amount: 10,
    timestamp: new Date().toISOString(),
    publicKey: bob.publicKey,
  };
  tx.signature = signTransaction(tx, bob.privateKey);

  assert.throws(() => chain.addTransaction(tx), /signature is invalid/i);
});

run("rejects overspend considering pending", () => {
  const chain = new Blockchain({ difficulty: 1, miningReward: 10 });
  const alice = createWallet();
  const bob = createWallet();

  chain.minePendingTransactions(alice.address);

  const tx1 = {
    fromAddress: alice.address,
    toAddress: bob.address,
    amount: 7,
    timestamp: new Date().toISOString(),
    publicKey: alice.publicKey,
  };
  tx1.signature = signTransaction(tx1, alice.privateKey);
  chain.addTransaction(tx1);

  const tx2 = {
    fromAddress: alice.address,
    toAddress: bob.address,
    amount: 5,
    timestamp: new Date().toISOString(),
    publicKey: alice.publicKey,
  };
  tx2.signature = signTransaction(tx2, alice.privateKey);

  assert.throws(() => chain.addTransaction(tx2), /insufficient balance/i);
});

run("detects chain tampering", () => {
  const chain = new Blockchain({ difficulty: 1, miningReward: 20 });
  const alice = createWallet();
  const bob = createWallet();

  chain.minePendingTransactions(alice.address);

  const tx = {
    fromAddress: alice.address,
    toAddress: bob.address,
    amount: 5,
    timestamp: new Date().toISOString(),
    publicKey: alice.publicKey,
  };
  tx.signature = signTransaction(tx, alice.privateKey);
  chain.addTransaction(tx);
  chain.minePendingTransactions(bob.address);

  chain.chain[2].transactions[0].amount = 999;
  assert.equal(chain.isChainValid(), false);
});

if (!process.exitCode) {
  // eslint-disable-next-line no-console
  console.log("All tests passed");
}
