/**
 * Fachada de compatibilidade: a implementação foi movida para `core/api`,
 * mantendo todos os imports existentes durante a migração das features.
 */
export { apiBaseUrl, authToken, wsBaseUrl } from "../core/api/config";
export { installNoriumFetchAuth } from "../core/api/fetchAuth";
