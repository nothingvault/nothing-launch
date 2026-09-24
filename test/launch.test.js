// Checks the real launch transaction (real pump.fun instructions with the first buy, no network):
//  - it fits in one Solana transaction (the 1,232-byte limit), even after Phantom adds its safety checks
//  - Phantom's signing order: the wallet signs first, the site adds the coin's signature after
//  - wallet safety checks and a changed priority fee are accepted; any other change is refused
//  - the lookup table is made once by the house wallet and reused after that
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  Keypair, PublicKey, TransactionInstruction, ComputeBudgetProgram, VersionedTransaction, TransactionMessage,
  AddressLookupTableAccount, Transaction, SystemProgram
} = require('@solana/web3.js');
const BN = require('bn.js');
const { createChain, LIGHTHOUSE_ID } = require('../src/chain');

const LIMIT = 1232;

// A pretend Solana that understands just enough: blockhashes, sending, and lookup tables.
function offlineChain(store, extra) {
  const k = () => JSON.stringify(Array.from(Keypair.generate().secretKey));
  const saved = store || { v: null };
  // the site's wallets stay the same from one visit to the next, like the real site
  saved.keys = saved.keys || { pool: k(), house: k() };
  const chain = createChain({ rpcUrl: 'http://127.0.0.1:9', poolSecret: saved.keys.pool, houseSecret: saved.keys.house, ...(extra || {}) },
    { altStore: { get: async () => saved.v, set: async (x) => { saved.v = x; } } });
  const c = chain.connection, sent = [], tables = saved.tables || (saved.tables = {}), houseTxs = [];
  const ALT = 'AddressLookupTab1e1111111111111111111111111';
  c.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 });
  c.getRecentPrioritizationFees = async () => [];
  c.getMinimumBalanceForRentExemption = async (n) => (n + 128) * 6960; // Solana's deposit rule
  c.getBlockHeight = async () => 900;
  let slotN = 12345 + Math.floor(Math.random() * 1e6); c.getSlot = async () => ++slotN;
  c.getAddressLookupTable = async (key) => {
    const t = tables[key.toBase58()];
    return { value: t ? new AddressLookupTableAccount({ key, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: chain.wallets.house.publicKey, addresses: t.map(a => new PublicKey(a)) } }) : null };
  };
  const sigs = new Set();
  c.sendRawTransaction = async (raw) => {
    const v = VersionedTransaction.deserialize(Uint8Array.from(raw));
    if (v.version === 'legacy') {
      const tx = Transaction.from(raw);
      for (const ix of tx.instructions) {
        if (ix.programId.toBase58() !== 'AddressLookupTab1e1111111111111111111111111') continue;
        const kind = ix.data.readUInt32LE(0), table = ix.keys[0].pubkey.toBase58();
        if (kind === 0) tables[table] = [];
        if (kind === 2) { const n = Number(ix.data.readBigUInt64LE(4)); for (let i = 0; i < n; i++) tables[table].push(new PublicKey(ix.data.subarray(12 + 32 * i, 44 + 32 * i)).toBase58()); }
      }
      houseTxs.push(tx);
    } else sent.push(v);
    const s = require('bs58').default.encode(v.signatures[0]); sigs.add(s); return s;
  };
  c.getSignatureStatuses = async (list) => ({ value: list.map(s => (sigs.has(s) ? { confirmationStatus: 'confirmed', err: null } : null)) });
  // pump.fun's settings (normally read from Solana)
  const pk = () => Keypair.generate().publicKey;
  const global = saved.global || (saved.global = { feeRecipient: pk(), feeRecipients: [pk(), pk()], reservedFeeRecipient: pk(), reservedFeeRecipients: [pk()], isHolderRewardEnabled: false, creatorFeeConfigurable: false });
  chain.hooks.globals = async () => ({ global, feeConfig: {} });
  chain.hooks.buyAmount = () => new BN('35000000000');
  void ALT;
  return { chain, sent, houseTxs, tables, saved };
}

// Phantom's side: sign first. Optionally change the transaction the way Phantom is allowed to.
async function phantomSign(chain, b64, user, change) {
  const v = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  assert.ok(v.signatures.every(s => s.every(b => b === 0)), 'nobody signed before the wallet');
  let tx = v;
  if (change) {
    const tables = [];
    for (const l of v.message.addressTableLookups) tables.push((await chain.connection.getAddressLookupTable(l.accountKey)).value);
    const m = TransactionMessage.decompile(v.message, { addressLookupTableAccounts: tables });
    change(m);
    tx = new VersionedTransaction(m.compileToV0Message(tables));
  }
  tx.sign([user]);
  return Buffer.from(tx.serialize()).toString('base64');
}
const FEE_TO = Keypair.generate().publicKey.toBase58();
const SPLIT = { poolBps: 7000, houseBps: 3000, feeTo: FEE_TO };
const launch = (chain, user, devSol = 0.01) => chain.buildLaunchTx({
  wallet: user.publicKey.toBase58(), name: 'Test Coin', symbol: 'TEST',
  uri: 'https://example.com/test.json', devBuyLamports: Math.round(devSol * 1e9), split: SPLIT
});
const lighthouse = (user) => new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_ID), keys: [{ pubkey: user.publicKey, isSigner: false, isWritable: false }], data: Buffer.alloc(40, 7) });

test('a launch with the first buy fits in one transaction, with room for Phantom\'s checks', async () => {
  const { chain } = offlineChain();
  const user = Keypair.generate();
  const b = await launch(chain, user);
  const size = Buffer.from(b.tx.b64, 'base64').length;
  assert.ok(size <= LIMIT, 'launch is ' + size + ' bytes');
  const signed = await phantomSign(chain, b.tx.b64, user, (m) => { m.instructions.push(lighthouse(user), lighthouse(user)); });
  const withChecks = Buffer.from(signed, 'base64').length;
  assert.ok(withChecks <= LIMIT, 'with two Phantom checks it is ' + withChecks + ' bytes');
  assert.ok(LIMIT - size >= 250, 'leaves ' + (LIMIT - size) + ' bytes spare');
  console.log('launch size', size, 'bytes; with two Phantom checks', withChecks, 'bytes; limit', LIMIT);
});

test('wallet signs first, the site signs second, the launch (with first buy) is complete', async () => {
  const { chain, sent } = offlineChain();
  const user = Keypair.generate();
  const b = await launch(chain, user);
  const signed = await phantomSign(chain, b.tx.b64, user);
  await chain.submitLaunchTx(b.tx, signed, user.publicKey.toBase58());
  assert.equal(sent.length, 1);
  const tx = sent[0], bytes = tx.message.serialize(), nacl = require('tweetnacl');
  for (let i = 0; i < tx.message.header.numRequiredSignatures; i++) assert.ok(nacl.sign.detached.verify(bytes, tx.signatures[i], tx.message.staticAccountKeys[i].toBytes()), 'signature ' + i + ' valid');
  assert.ok(tx.message.staticAccountKeys.some(k => k.toBase58() === b.mint), 'coin signed');
  // the first buy really is inside the launch
  const tables = []; for (const l of tx.message.addressTableLookups) tables.push((await chain.connection.getAddressLookupTable(l.accountKey)).value);
  const ixs = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables }).instructions;
  const pumpIxs = ixs.filter(ix => ix.programId.toBase58().startsWith('6EF8rrec'));
  assert.equal(pumpIxs.length, 2, 'create + buy');
});

test("Phantom's safety checks and a changed priority fee are accepted", async () => {
  const { chain, sent } = offlineChain();
  const user = Keypair.generate();
  const b = await launch(chain, user);
  const signed = await phantomSign(chain, b.tx.b64, user, (m) => {
    m.instructions = m.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId));
    m.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 99999 }));
    m.instructions.push(lighthouse(user));
  });
  await chain.submitLaunchTx(b.tx, signed, user.publicKey.toBase58());
  assert.equal(sent.length, 1);
});

test('anything else changed is refused, and nothing is sent', async () => {
  const { chain, sent } = offlineChain();
  const user = Keypair.generate(), thief = Keypair.generate();
  const b = await launch(chain, user);
  // someone swaps where the setup payment goes
  const bad = await phantomSign(chain, b.tx.b64, user, (m) => {
    const last = m.instructions[m.instructions.length - 1];
    m.instructions[m.instructions.length - 1] = SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: thief.publicKey, lamports: 7_000_000 });
    void last;
  });
  await assert.rejects(() => chain.submitLaunchTx(b.tx, bad, user.publicKey.toBase58()), /does not match/);
  // a bigger first buy slipped in
  const bad2 = await phantomSign(chain, b.tx.b64, user, (m) => { m.instructions.push(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: thief.publicKey, lamports: 1 })); });
  await assert.rejects(() => chain.submitLaunchTx(b.tx, bad2, user.publicKey.toBase58()), /does not match/);
  // signed by someone else
  const v = VersionedTransaction.deserialize(Buffer.from(b.tx.b64, 'base64'));
  v.signatures[0] = require('tweetnacl').sign.detached(v.message.serialize(), thief.secretKey);
  const other = Buffer.from(v.serialize()).toString('base64');
  await assert.rejects(() => chain.submitLaunchTx(b.tx, other, user.publicKey.toBase58()), /not signed by your wallet|signature does not match/);
  assert.equal(sent.length, 0);
});

test('the lookup table is made once by the house wallet, then reused', async () => {
  const store = { v: null };
  const one = offlineChain(store);
  await launch(one.chain, Keypair.generate());
  assert.ok(one.houseTxs.length >= 2, 'made the table, then filled it (' + one.houseTxs.length + ' steps)');
  assert.ok(store.v && store.v.address, 'remembered where it is');
  const two = offlineChain(store);
  await launch(two.chain, Keypair.generate());
  await launch(two.chain, Keypair.generate());
  // After the first time, the only setup is each launch's own small table (one step per launch, deposit returned later).
  assert.equal(two.houseTxs.length, 2, 'one small table per launch, nothing else');
  for (const tx of two.houseTxs) assert.ok(!tx.instructions.some(ix => ix.keys.some(k => k.pubkey.toBase58() === store.v.address)), 'the shared table is not changed again');
  // No signer is ever in the table (Solana doesn't allow that), and neither the person nor the coin is.
  const addrs = store.tables[store.v.address];
  assert.ok(addrs.length >= 12, addrs.length + ' shared accounts');
});

test('launching without a first buy still works (and still fits)', async () => {
  const { chain, sent } = offlineChain();
  const user = Keypair.generate();
  const b = await launch(chain, user, 0);
  const signed = await phantomSign(chain, b.tx.b64, user);
  await chain.submitLaunchTx(b.tx, signed, user.publicKey.toBase58());
  assert.equal(sent.length, 1);
});

test('the nothing coin launches at its reserved address, its secret never leaves the server, wallet still signs first', async () => {
  const reserved = Keypair.generate();
  const bs = require('bs58').default;
  const creator = Keypair.generate();
  const { chain, sent } = offlineChain(null, { nothingMintSecret: bs.encode(reserved.secretKey), nothingMint: reserved.publicKey.toBase58(), nothingCreatorSecret: bs.encode(creator.secretKey) });
  assert.equal(chain.reservedMint, reserved.publicKey.toBase58());
  assert.equal(chain.nothingCreator, creator.publicKey.toBase58());
  const user = Keypair.generate();
  const b = await chain.buildLaunchTx({ wallet: user.publicKey.toBase58(), name: 'nothing', symbol: 'NOTHING', uri: 'https://ipfs.io/ipfs/x', devBuyLamports: 10_000_000, useReserved: true, split: SPLIT });
  assert.equal(b.mint, reserved.publicKey.toBase58(), 'created at the reserved address');
  assert.equal(b.tx.mintSecret, null, 'the reserved secret is not stored with the draft');
  assert.ok(!JSON.stringify(b).includes(bs.encode(reserved.secretKey)), 'secret appears nowhere in what is saved or sent to the page');
  const signed = await phantomSign(chain, b.tx.b64, user);
  await chain.submitLaunchTx(b.tx, signed, user.publicKey.toBase58());
  assert.equal(sent.length, 1);
  const tx = sent[0], bytes = tx.message.serialize(), nacl = require('tweetnacl');
  for (let i = 0; i < tx.message.header.numRequiredSignatures; i++) assert.ok(nacl.sign.detached.verify(bytes, tx.signatures[i], tx.message.staticAccountKeys[i].toBytes()));
  assert.ok(tx.message.staticAccountKeys.some(k => k.equals(reserved.publicKey)));
  // the launching wallet is the creator (so it is not marked "Offchain")
  const tables = []; for (const l of tx.message.addressTableLookups) tables.push((await chain.connection.getAddressLookupTable(l.accountKey)).value);
  const ixs = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables }).instructions;
  const create = ixs.find(ix => ix.programId.toBase58().startsWith('6EF8rrec'));
  assert.ok(Buffer.from(create.data).includes(user.publicKey.toBuffer()), 'the launching wallet is the creator');
  assert.ok(!Buffer.from(create.data).includes(creator.publicKey.toBuffer()), 'not a separate creator wallet');
  assert.ok(!Buffer.from(create.data).includes(chain.wallets.house.publicKey.toBuffer()), 'not the site\'s wallet');
});

test('every coin: the wallet that launches is the creator and makes the first buy, and the 70/30 split is locked in the same transaction', async () => {
  const { chain } = offlineChain();
  const user = Keypair.generate();
  const b = await launch(chain, user);
  const v = VersionedTransaction.deserialize(Buffer.from(b.tx.b64, 'base64'));
  const tables = []; for (const l of v.message.addressTableLookups) tables.push((await chain.connection.getAddressLookupTable(l.accountKey)).value);
  const ixs = TransactionMessage.decompile(v.message, { addressLookupTableAccounts: tables }).instructions;
  const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
  const pumpIxs = ixs.filter(ix => ix.programId.toBase58() === PUMP);
  assert.equal(pumpIxs.length, 2, 'create + first buy');
  const [create, buy] = pumpIxs;
  assert.ok(Buffer.from(create.data).includes(user.publicKey.toBuffer()), 'creator = the launching wallet');
  assert.ok(!Buffer.from(create.data).includes(chain.wallets.house.publicKey.toBuffer()), 'the site\'s wallet is not the creator');
  assert.ok(buy.keys.some(k => k.pubkey.equals(user.publicKey) && k.isSigner), 'the launching wallet makes the first buy');
  const fee = ixs.filter(ix => ix.programId.toBase58() === FEES);
  assert.equal(fee.length, 2, 'open the fee split, then set and lock it');
  const upd = fee[1];
  assert.ok(upd.keys.some(k => k.pubkey.equals(user.publicKey) && k.isSigner), 'signed by the launching wallet');
  const data = Buffer.from(upd.data);
  assert.ok(data.includes(chain.wallets.pool.publicKey.toBuffer()), 'vault gets a share');
  assert.ok(data.includes(new PublicKey(FEE_TO).toBuffer()), '30% wallet gets a share');
  assert.equal(data.readUInt16LE(data.indexOf(chain.wallets.pool.publicKey.toBuffer()) + 32), 7000, 'vault share is 70%');
  assert.equal(data.readUInt16LE(data.indexOf(new PublicKey(FEE_TO).toBuffer()) + 32), 3000, '30% wallet share is 30%');
  assert.ok(ixs.indexOf(fee[0]) > ixs.indexOf(buy), 'split is set after the coin exists');
  // the only payment to the site: the launcher paying back this launch's own table (deposit + its small fees)
  const pays = ixs.filter(ix => ix.programId.equals(SystemProgram.programId));
  assert.equal(pays.length, 1, 'one setup repayment');
  assert.ok(pays[0].keys[0].pubkey.equals(user.publicKey) && pays[0].keys[1].pubkey.equals(chain.wallets.house.publicKey), 'from the launcher to the site wallet');
  const lamports = Number(Buffer.from(pays[0].data).readBigUInt64LE(4));
  assert.equal(lamports, b.tx.setupLamports, 'exactly the setup cost');
  assert.ok(lamports > 2_000_000 && lamports < 6_000_000, 'about 0.004 SOL, was ' + lamports);
});

test('launch tables are cleaned up in batches: switched off, then closed, deposits back to the site wallet', async () => {
  const { chain } = offlineChain();
  const c = chain.connection, house = chain.wallets.house.publicKey;
  const MAX = BigInt('18446744073709551615');
  const state = {}; // address -> deactivation slot
  const addrs = Array.from({ length: 45 }, () => Keypair.generate().publicKey.toBase58());
  addrs.forEach(a => { state[a] = MAX; });
  let slot = 1000;
  c.getSlot = async () => slot;
  const encode = (deact) => { const b = Buffer.alloc(56); b.writeUInt32LE(1, 0); b.writeBigUInt64LE(deact, 4); b.writeUInt8(1, 21); house.toBuffer().copy(b, 22); return b; };
  c.getMultipleAccountsInfo = async (keys) => keys.map(k => (state[k.toBase58()] === undefined ? null : { data: encode(state[k.toBase58()]) }));
  const txs = [];
  c.sendRawTransaction = async (raw) => {
    const tx = Transaction.from(raw); txs.push(tx);
    for (const ix of tx.instructions) {
      if (ix.programId.toBase58() !== 'AddressLookupTab1e1111111111111111111111111') continue;
      const kind = ix.data.readUInt32LE(0), a = ix.keys[0].pubkey.toBase58();
      if (kind === 3) state[a] = BigInt(slot);
      if (kind === 4) { assert.ok(ix.keys[2].pubkey.equals(house), 'deposit goes back to the site wallet'); delete state[a]; }
    }
    const sig = require('bs58').default.encode(tx.signature); seen.add(sig); return sig;
  };
  const seen = new Set();
  c.getSignatureStatuses = async (list) => ({ value: list.map(sg => (seen.has(sg) ? { confirmationStatus: 'confirmed', err: null } : null)) });
  const r1 = await chain.retireTables(addrs);
  assert.ok(addrs.every(a => r1[a] === 'off'), 'all switched off');
  assert.equal(txs.length, 3, '45 tables in 3 transactions');
  const r2 = await chain.retireTables(addrs);
  assert.ok(addrs.every(a => r2[a] === 'wait'), 'closing waits for Solana\'s cooldown');
  slot += 600;
  const r3 = await chain.retireTables(addrs);
  assert.ok(addrs.every(a => r3[a] === 'closed'), 'all closed');
  const r4 = await chain.retireTables(addrs);
  assert.ok(addrs.every(a => r4[a] === 'gone'));
});


test('a mismatched reserved address switches the reserved launch off instead of breaking the site', async () => {
  const bs = require('bs58').default;
  const { chain } = offlineChain(null, { nothingMintSecret: bs.encode(Keypair.generate().secretKey), nothingMint: Keypair.generate().publicKey.toBase58() });
  assert.equal(chain.reservedMint, null);
  await assert.rejects(() => chain.buildLaunchTx({ wallet: Keypair.generate().publicKey.toBase58(), name: 'x', symbol: 'X', uri: 'https://a', devBuyLamports: 0, useReserved: true, split: SPLIT }), /not set up/);
});

test('audit: when a send passes its deadline and Solana can\'t be asked, it is NOT marked as never sent', async () => {
  const { chain } = offlineChain();
  const c = chain.connection;
  const tx = new Transaction({ feePayer: chain.wallets.pool.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 });
  tx.add(SystemProgram.transfer({ fromPubkey: chain.wallets.pool.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.sign(chain.wallets.pool);
  const b = { raw: tx.serialize().toString('base64'), blockhash: tx.recentBlockhash, lastValidBlockHeight: 1000 };
  c.sendRawTransaction = async () => 'x';
  c.getBlockHeight = async () => 1040;
  c.getSignatureStatuses = async () => { throw new Error('429 Too Many Requests'); };
  await assert.rejects(() => chain.sendBuilt(b), (e) => !e.expired);
  c.getSignatureStatuses = async () => ({ value: [null] }); // clearly never seen
  await assert.rejects(() => chain.sendBuilt(b), (e) => e.expired === true);
});

test('holders are read with Helius\'s paged lookup: every page, people only, amounts exact', async () => {
  const people = Array.from({ length: 2345 }, () => Keypair.generate().publicKey.toBase58());
  const curve = (await PublicKey.findProgramAddress([Buffer.from('bonding-curve')], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')))[0].toBase58();
  const accounts = people.map((o, i) => ({ owner: o, amount: 1000000 + i })).concat([{ owner: curve, amount: 999999999 }, { owner: people[0], amount: 5 }, { owner: people[1], amount: 0 }]);
  const pagesAsked = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method !== 'getTokenAccounts') throw new Error('unexpected ' + body.method);
    pagesAsked.push(body.params.page);
    const start = (body.params.page - 1) * body.params.limit;
    return { status: 200, json: async () => ({ result: { token_accounts: accounts.slice(start, start + body.params.limit) } }) };
  };
  const k = () => JSON.stringify(Array.from(Keypair.generate().secretKey));
  const chain = createChain({ rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=test', poolSecret: k(), houseSecret: k() }, { fetchImpl });
  const h = await chain.holders(Keypair.generate().publicKey.toBase58());
  assert.deepEqual(pagesAsked, [1, 2, 3]);
  assert.equal(Object.keys(h).length, 2345, 'every person, the bonding curve left out');
  assert.equal(h[curve], undefined);
  assert.equal(h[people[0]], 1000005n, 'two accounts of one wallet added together');
  assert.equal(h[people[2344]], 1002344n);
});
