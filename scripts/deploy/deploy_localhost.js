/**
 * GenoChain Localhost Deployment Entrypoint
 * Delegates directly to the canonical scripts/deploy/deploy.js pipeline targeting `localhost`
 * so zero drifted legacy deployment logic exists between localhost and production scripts.
 */
if (!process.env.DEPLOY_TARGET_NETWORK) {
  process.env.DEPLOY_TARGET_NETWORK = "localhost";
}
await import("./deploy.js");
