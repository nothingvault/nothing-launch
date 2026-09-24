# nothing — launch code

[nothingvault.com](https://nothingvault.com) is a launchpad for [pump.fun](https://pump.fun) coins. This repository is the part of the site that builds the launch transaction a creator signs, and checks it before it is sent. It is published so anyone (wallets, security teams, users) can see exactly what a creator is asked to sign.

## What one launch does

Every launch is **one Solana transaction**, signed by the creator's own wallet. It contains only pump.fun's official programs:

1. **Create the coin** on pump.fun (`create_v2`). The creator's wallet is the coin's creator.
2. **The creator's first buy** (`buy`), paid by the creator's wallet, for the amount the creator typed in.
3. **Set the creator-fee split** with pump.fun's official fee-sharing program (`create_fee_sharing_config`, then `update_fee_shares`), which locks it permanently:
   - **70%** of the coin's creator fees go to the **nothing vault**, which pays out to holders of the nothing coin.
   - **30%** go to the platform as its fee for running the site.

Nothing else is in the transaction. The site never holds the creator's SOL or coins: the creator's wallet pays for the launch and receives the coins from the first buy directly.

Because the split is set in the same transaction that creates the coin, the coin never exists without it, and nobody (including the site) can change it afterwards. Anyone can verify the split of any coin on-chain in pump.fun's fee-sharing account for that coin.

## Signing order

The creator's wallet always signs first. The site then adds one more signature: the new coin's address key (the mint), which pump.fun requires when a coin is created. Before adding it, the site checks that the signed transaction is exactly the one it prepared (see `submitLaunchTx` in `src/chain.js`): paid by the creator's wallet, signed by it, and with every instruction unchanged. Wallet-added safety checks (Lighthouse) and priority-fee changes are allowed; anything else is refused and nothing is sent.

## Lookup tables

A launch plus first buy plus the fee split is too large for one plain Solana transaction, so it uses address lookup tables:

- one shared table with the accounts every launch uses (pump.fun's programs and global accounts);
- one small table per launch with that coin's own accounts. The site's wallet pays its small deposit and closes it a few minutes later to get the deposit back (`retireTable`).

The site waits until the per-launch table is finalized before handing the transaction to the wallet, so wallets can simulate it.

## Files

- `src/chain.js` — builds the launch transaction (`buildLaunchTx`), checks and sends the signed one (`submitLaunchTx`), and the other Solana calls the site makes (reading coins, collecting fees into the vault, paying holders).
- `src/wallet.js` — the browser code that connects the wallet and asks it to sign.
- `test/launch.test.js` — tests: the launch fits in one transaction with room for wallet checks, the wallet signs first, the creator is the launching wallet, the 70/30 split is in the same transaction, and a changed transaction is refused.

Run the tests with `npm install` then `npm test`. No keys or network are needed.

## Not included

Server secrets (wallet keys, API keys) are never in code: they are set as environment variables on the server. The rest of the site (pages, database and admin tools) is not published.

## License

MIT
