/**
 * The OMP-only modules below exist in the host runtime (resolved by the
 * host's extension loader hook) but are not dependencies of this repo, so
 * they are declared ambiently to keep `tsc` clean. Every dynamic import of
 * these specifiers MUST stay inside try/catch: the specifier is literal (the
 * host only rewrites literal specifiers) and the import rejects on any host
 * where the module does not exist.
 */
declare module '@oh-my-pi/pi-coding-agent/registry/agent-registry';
