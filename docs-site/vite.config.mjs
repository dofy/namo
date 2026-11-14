import { fileURLToPath } from 'node:url';

// The preview may serve documentation assets only, never the parent workspace.
export default { server: { fs: { strict: true, allow: [fileURLToPath(new URL('.', import.meta.url))] } } };
