# Telegram Approval Gateway

## Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram, `/newbot`, get a token.
2. Message [@userinfobot](https://t.me/userinfobot) to get your numeric Telegram user ID.
3. In `.env`:
   ```
   TELEGRAM_BOT_TOKEN=<from BotFather>
   TELEGRAM_ALLOWED_USER_IDS=<your numeric id>[,<another id>...]
   ```
4. Start a chat with your bot (send it `/start`) so it's allowed to message you.
5. `pnpm run telegram-bot` to start long-polling.

## What gets sent

`requestApproval()` (`src/telegram/bot.ts`) sends a review card to every
allowlisted chat ID:

```
🔎 BUG BOUNTY REVIEW

Program:
<program name>

Asset:
<target>

Status:
Needs Approval

Action:
<what's being asked>
```
`[✅ Approve]  [❌ Reject]`
`[📄 Details]`

matching the format in project brief section 11 exactly.

## Security

- **Allowlist is enforced at decision time, not just send time.**
  `handleApprovalDecision()` (`src/telegram/approvalHandler.ts`) calls
  `isAllowedTelegramUser()` before doing anything else — a callback from a
  chat ID not in `TELEGRAM_ALLOWED_USER_IDS` is refused and logged with
  `outcome: "denied_not_allowlisted"`, and the underlying Approval/Task rows
  are left untouched.
- **One decision per approval.** `decideApproval()` throws if the approval
  isn't `pending` anymore — a second tap (or a replayed callback) can't
  flip an already-decided approval.
- **The bot token is never logged.** `src/logging/logger.ts` redacts any
  field whose key matches `/token|secret|key|password|authorization/i`.
- Approving in Telegram transitions the linked Task
  `waiting_approval -> approved`; rejecting transitions it
  `waiting_approval -> rejected`. Both are enforced by the Task state
  machine (`src/domain/tasks.ts`), not by the Telegram handler itself, so
  the same rule applies whether the decision comes from Telegram, the CLI,
  or a test.

## Approval delivery is decoupled from approval state

`requestApproval()` always creates the `Approval` database row first, then
*attempts* Telegram delivery. If Telegram isn't configured (no token, no
allowlist) or the send fails, the Approval row still exists as `pending` —
delivery failure is reported back to the caller (`{delivered: false,
deliveryError}`) rather than thrown, and never silently promotes the
approval to decided. See `scripts/e2e-demo.ts` for how this is used to
demonstrate the full pipeline even without a configured bot.

## What's verified vs. not

- **Verified (real, no network):** allowlist enforcement, callback-data
  parsing/formatting, one-decision-per-approval, Task state transitions on
  approve/reject, denial logging — all covered by
  `test/telegram-approval.test.ts` (8 tests) and exercised live via
  `handleApprovalDecision()` in `scripts/e2e-demo.ts`.
- **Not yet verified in this session:** an actual live round-trip through
  the Telegram Bot API (sending a real message, a human tapping a real
  inline button, `grammy`'s `callback_query` handler firing). This needs a
  real `TELEGRAM_BOT_TOKEN`, which wasn't available in this environment. The
  code path (`src/telegram/bot.ts`) is a direct, fairly thin wrapper over
  `grammy`'s documented API (`bot.api.sendMessage` with `reply_markup`,
  `bot.on("callback_query:data")`, `ctx.answerCallbackQuery`,
  `ctx.editMessageText`) — supply a token and run `pnpm run telegram-bot`
  plus `pnpm run e2e:demo` to complete live verification.
