import { AsyncLocalStorage } from 'node:async_hooks';

const sessions = new AsyncLocalStorage();
export const currentConfirmationSession = threadId => {
  const s = sessions.getStore();
  return s?.scope.threadId === threadId ? s : null;
};
export const withConfirmationSession = (session, run) => sessions.run(session, run);

export async function createConfirmationSession(store, scope, context = {}) {
  const session = {
    store, scope, context, rows: await store.list(scope), createdIds: new Set(),
    pending() { return this.rows.filter(r => r.state === 'pending'); },
    async refresh() { this.rows = await store.list(scope); return this.rows; },
    async propose(payload) {
      const row = await store.propose(scope, { ...payload, context: this.context });
      await this.refresh();
      this.createdIds.add(row.id);
      return this.rows.find(r => r.id === row.id);
    },
    async close(row, state, decisionKey) {
      const done = await store.close(scope, row.id, state, decisionKey);
      await this.refresh();
      return done;
    },
  };
  return session;
}
