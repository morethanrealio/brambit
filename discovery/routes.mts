import { DiscoveryError, type DiscoveryStore } from './store.mjs';
export interface RouteIO {
    admin(): boolean;
    user(): Promise<{
        id: string;
    } | null>;
    read(): Promise<unknown>;
    limit(bucket: string): boolean;
    send(status: number, body: unknown): unknown;
    error(error: unknown): unknown;
    validateChannel?(user: string, input: unknown): Promise<void>;
}
// Same-origin / CSRF is checked by the host before this dispatch. Never trust user_id from owner body.
export async function discoveryRoutes(path: string, method: string, store: DiscoveryStore, io: RouteIO): Promise<boolean> {
    const admin = path === '/api/admin/discovery' || path.startsWith('/api/admin/discovery/');
    const owner = path === '/api/discovery' || path.startsWith('/api/discovery/');
    if (!admin && !owner)
        return false;
    try {
        if (admin) {
            if (!io.admin())
                return true;
            if (method === 'GET' && path === '/api/admin/discovery') {
                io.send(200, await store.overview());
                return true;
            }
            if (method === 'GET' && path === '/api/admin/discovery/candidates') {
                io.send(200, await store.candidates());
                return true;
            }
            const action = ({ '/api/admin/discovery/settings': 'configure', '/api/admin/discovery/invite': 'invite' } as const)[path as '/api/admin/discovery/settings'];
            if (!action) {
                io.send(404, { error: 'Recurso não encontrado.' });
                return true;
            }
            if (method !== 'POST') {
                io.send(405, { error: 'Método não suportado.' });
                return true;
            }
            if (io.limit('discovery-admin'))
                return true;
            io.send(200, await store[action](await io.read()));
            return true;
        }
        io.send(404, { error: 'A jornada do usuário é controlada na conversa com seu assistente.' });
        return true;
    }
    catch (e) {
        if (e instanceof DiscoveryError)
            io.send(e.status, { error: e.message });
        else
            io.error(e);
        return true;
    }
}
