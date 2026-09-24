# nothing launch code

[nothingvault.com](https://nothingvault.com/) is a launchpad for [pump.fun](https://pump.fun/) coins.

This repository contains the code responsible for building and verifying the transaction a creator signs when launching through nothing.

It is public so creators, wallets, security researchers, and users can independently inspect the launch process and verify exactly what a creator is asked to sign.

## What happens during a launch

Every launch is completed in a single Solana transaction signed by the creator's own wallet.

The transaction performs four actions:

**1. Create the coin**
The coin is created through pump.fun using `create_v2`. The connected wallet is recorded as the creator.

**2. Complete the creator's first buy**
The creator's first buy, for the amount they enter, is paid directly from their wallet, and the purchased tokens are sent directly to that wallet.

**3. Configure the creator-fee split**
The transaction uses pump.fun's fee-sharing program through `create_fee_sharing_config` and `update_fee_shares`.

Creator fees are split:

* 70% to the nothing vault, which is used for payouts to holders of nothing.
* 30% to the platform.

**4. Repay the launch setup**
The creator pays back the small setup cost the site puts down for the launch's temporary lookup table (see below): the table's deposit plus the network fees to create and close it, about 0.004 SOL in total. This is the only payment to the site in the transaction, and the amount is shown in the wallet before signing.

The site does not take custody of the creator's SOL or purchased tokens.

Because the fee split is configured in the same transaction that creates the coin, the coin never exists without it. Once set, pump.fun locks the split: it cannot be changed afterwards by anyone, including the site.

The resulting configuration can be independently verified on-chain through pump.fun's fee-sharing account for the coin.

## Transaction verification

The creator's wallet signs the transaction first.

The site then adds the signature required for the new coin's mint address.

Before the transaction is submitted, `submitLaunchTx` in `src/chain.js` verifies that the signed transaction still matches the launch transaction that was prepared.

The verification checks that:

* The creator's wallet is the transaction payer.
* The creator signed the transaction.
* The launch instructions have not been changed.
* No unexpected instructions were added.

Supported wallet security instructions, including Lighthouse checks, are allowed. Priority-fee adjustments are also allowed.

Any other modification causes the transaction to be rejected before submission.

## Address lookup tables

The full launch transaction contains more accounts than can fit in a standard Solana transaction without address lookup tables.

The launch process uses:

* One shared lookup table for accounts used across launches.
* One temporary lookup table for accounts specific to the coin being launched.

The temporary table is finalized before the transaction is sent to the creator's wallet so compatible wallets can simulate and inspect the transaction before signing.

A few minutes after the launch, the temporary table is closed through `retireTables`, and its deposit returns to the site wallet that put it down.

## Code to review

`src/chain.js`
Contains the core Solana transaction logic, including:

* `buildLaunchTx` for building launch transactions.
* `submitLaunchTx` for verifying and submitting signed transactions.
* Supporting Solana calls used by the platform.

`src/wallet.js`
Contains the browser-side wallet connection and transaction-signing flow.

`test/launch.test.js`
Contains automated tests covering the launch process, including:

* The launch fits inside one transaction.
* The creator's wallet signs first.
* The connected wallet is recorded as the creator.
* The 70/30 creator-fee split is included in the launch transaction.
* The only payment to the site is the setup repayment, for the exact setup cost.
* Modified launch transactions are rejected.

## Run the tests

```bash
npm install
npm test
```

No wallet keys or live network connection are required to run the test suite.

## Repository scope

This repository contains the code relevant to building, signing, verifying, and submitting nothing launch transactions.

It is published so the launch process can be independently reviewed and verified.

## License

MIT
