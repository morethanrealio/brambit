// One persisted occurrence per reminder slot. Dependencies are injected: this
// module never imports the database, server, or channel clients.
export function createReminderExecutor(store, { deliver } = {}) {
  if (typeof deliver !== 'function') throw new TypeError('Reminder delivery is required');

  async function execute(reminder) {
    const claim = await store.claim(reminder);
    if (!claim) return { status: 'skipped' };
    // The second fence catches cancellation, an expired claim, and another
    // worker's recovery immediately before the external side effect.
    if (!await store.begin(claim)) return { status: 'skipped' };

    let outcome;
    try {
      const receipt = await deliver(reminder, { tracking: store.deliveryTracking?.(claim) });
      const validReceipt = receipt?.status === 'accepted'
        && typeof receipt.id === 'string' && receipt.id.trim()
        && receipt.id.length <= 1000 && receipt.channel === reminder.channel;
      if (validReceipt) {
        outcome = { status: 'accepted', receipt: { id: receipt.id, channel: receipt.channel } };
      } else if (receipt?.status === 'failed' || receipt?.skipped === true) {
        outcome = { status: 'failed', errorCode: 'DELIVERY_REJECTED' };
      } else {
        // A successful HTTP call without a receipt can still have sent the
        // message. Never repeat that occurrence automatically.
        outcome = { status: 'uncertain', errorCode: 'RECEIPT_MISSING' };
      }
    } catch (error) {
      outcome = error?.definitive === true
        ? { status: 'failed', errorCode: 'DELIVERY_REJECTED' }
        : { status: 'uncertain', errorCode: 'DELIVERY_UNCERTAIN' };
    }

    // Keep persistence outside the delivery catch. A lost acknowledgement in
    // our database must not relabel a provider acceptance as a rejected send.
    // Recovery records an expired sending lease as uncertain, without replay.
    const result = await store.finish(claim, outcome);
    if (!result) throw Object.assign(new Error('Reminder outcome was not recorded'), {
      code: 'REMINDER_OUTCOME_UNRECORDED',
    });
    return { ...result, ...(outcome.receipt ? { receipt: outcome.receipt } : {}) };
  }

  return { execute, recover: () => store.recoverExpired() };
}
