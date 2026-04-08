import { setGlobalDevModeChecks } from "reselect";

/**
 * Privacy Pools (and similar) use selectors whose inputs return a new `[]` per
 * call; reselect 5+ logs a dev warning that is noisy for CLI runs and does not
 * indicate incorrect balances. Disable the stability check globally.
 */
setGlobalDevModeChecks({
  inputStabilityCheck: "never",
});
