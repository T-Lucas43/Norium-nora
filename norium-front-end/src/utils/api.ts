/**
 * Fachada de compatibilidade: a implementação foi movida para `core/api`,
 * mantendo todos os imports existentes durante a migração das features.
 */
export { apiBaseUrl, authToken, wsBaseUrl } from "../core/api/config";
export { authenticatedWebSocketUrl } from "../core/api/client";
export { installNoriumFetchAuth } from "../core/api/fetchAuth";
